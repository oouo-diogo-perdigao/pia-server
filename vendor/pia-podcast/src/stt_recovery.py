from src.settings_store import get as setting

"""Bounded audio-backed recovery. Never delete repetition or invent timestamps."""
from collections import deque
from dataclasses import dataclass
import logging
import math
import os
import re
import unicodedata


class RepetitionRecoveryError(RuntimeError):
    pass


@dataclass(frozen=True)
class RecoveryOptions:
    enabled: bool = True
    repetitions: int = 6
    max_phrase: int = 8
    max_retries: int = 3
    max_repairs: int = 12
    window_seconds: float = 60

    @classmethod
    def from_env(cls):
        value = cls(
            enabled=setting("STT_RECOVERY_ENABLED", "true").lower()
            not in ("false", "0"),
            repetitions=int(setting("STT_RECOVERY_REPETITIONS", "6")),
            max_phrase=int(setting("STT_RECOVERY_MAX_PHRASE_WORDS", "8")),
            max_retries=int(setting("STT_RECOVERY_MAX_RETRIES", "3")),
            max_repairs=int(setting("STT_RECOVERY_MAX_REPAIRS", "12")),
            window_seconds=float(setting("STT_RECOVERY_WINDOW_SECONDS", "60")),
        )
        if (
            not 2 <= value.repetitions <= 100
            or not 1 <= value.max_phrase <= 32
            or not 1 <= value.max_retries <= 10
            or not 1 <= value.max_repairs <= 100
            or not 5 <= value.window_seconds <= 600
        ):
            raise ValueError("Configuração STT_RECOVERY inválida.")
        return value


def tokens(text):
    return list(re.finditer(r"[^\W_]+", text, flags=re.UNICODE))


def normalized(text):
    return "".join(
        c
        for c in unicodedata.normalize("NFD", text.casefold())
        if not unicodedata.combining(c)
    )


@dataclass(frozen=True)
class Problem:
    segment: int
    token: int
    char: int
    phrase: int


class RepetitionDetector:
    def __init__(self, options=None):
        self.options = options or RecoveryOptions.from_env()
        self.history = deque(maxlen=self.options.repetitions * self.options.max_phrase)
        self.previous_end = None

    def feed(self, segment, index):
        if not self.options.enabled:
            return None
        start, end = segment.get("start"), segment.get("end")
        if (
            isinstance(start, (int, float))
            and self.previous_end is not None
            and start - self.previous_end > 3
        ):
            self.history.clear()
        self.previous_end = end if isinstance(end, (int, float)) else None
        for local, match in enumerate(tokens(segment["text"])):
            self.history.append(
                (normalized(match.group()), index, local, match.start())
            )
            history = list(self.history)
            for size in range(1, self.options.max_phrase + 1):
                count = size * self.options.repetitions
                if len(history) < count:
                    break
                values = [item[0] for item in history[-count:]]
                if values == values[-size:] * self.options.repetitions:
                    first = history[-count]
                    if (
                        first[1] == index
                        and segment.get("_audio_retry")
                        and bounded_aligned_repeat(
                            segment, first[2], size, self.options.repetitions
                        )
                    ):
                        # This bounded utterance was decoded again from audio, with
                        # distinct word intervals. It is not an endless decoder loop.
                        self.history.clear()
                        continue
                    return Problem(first[1], first[2], first[3], size)
        return None


def find_repetition(segments, options=None):
    detector = RepetitionDetector(options)
    for index, segment in enumerate(segments):
        problem = detector.feed(segment, index)
        if problem:
            return problem
    return None


def segment_dict(segment, offset=0):
    if isinstance(segment, dict):
        get = segment.get
    else:
        get = lambda key, default=None: getattr(segment, key, default)
    result = {
        "start": float(get("start")) + offset,
        "end": float(get("end")) + offset,
        "text": str(get("text") or "").strip(),
    }
    if get("_audio_retry") is True:
        result["_audio_retry"] = True
    if (
        not math.isfinite(result["start"])
        or not math.isfinite(result["end"])
        or result["start"] < 0
        or result["end"] < result["start"]
    ):
        raise RepetitionRecoveryError("Timestamps inválidos na transcrição STT.")
    words = get("_words") or get("words")
    if isinstance(words, (list, tuple)):
        result["_words"] = []
        for word in words:
            wg = (
                word.get
                if isinstance(word, dict)
                else lambda k, d=None, w=word: getattr(w, k, d)
            )
            result["_words"].append(
                {
                    "start": float(wg("start")) + offset,
                    "end": float(wg("end")) + offset,
                    "word": str(wg("word", wg("text", ""))),
                }
            )
    return result


def aligned_words(segment):
    words = segment.get("_words")
    if not words:
        return None
    if [normalized(t.group()) for w in words for t in tokens(w["word"])] != [
        normalized(t.group()) for t in tokens(segment["text"])
    ]:
        return None
    previous = segment["start"]
    for word in words:
        if (
            not all(math.isfinite(word[k]) for k in ("start", "end"))
            or word["start"] < previous - 0.001
            or word["end"] < word["start"]
            or word["end"] > segment["end"] + 0.1
        ):
            return None
        previous = word["end"]
    return words


def bounded_aligned_repeat(segment, first, size, repetitions):
    words = aligned_words(segment)
    if not words:
        return False
    matches = tokens(segment["text"])
    pattern = [normalized(t.group()) for t in matches[first : first + size]]
    last = first
    while [
        normalized(t.group()) for t in matches[last : last + size]
    ] == pattern and last + size <= len(matches):
        last += size
    if last - first > size * repetitions * 2:
        return False
    count = 0
    selected = []
    for word in words:
        length = len(tokens(word["word"]))
        if count < last and count + length > first:
            selected.append(word)
        count += length
    return bool(selected) and all(
        word["end"] - word["start"] >= 0.02 for word in selected
    )


def trim_left_context(segments, start):
    """Discard context using actual word boundaries; None asks the decoder to retry without it."""
    result = []
    for segment in segments:
        if segment["end"] <= start:
            continue
        if segment["start"] < start:
            words = aligned_words(segment)
            if not words:
                return None
            if any(word["start"] < start < word["end"] for word in words):
                return None
            kept = [word for word in words if word["start"] >= start]
            if not kept:
                continue
            segment = {
                **segment,
                "start": kept[0]["start"],
                "end": kept[-1]["end"],
                "text": "".join(w["word"] for w in kept).strip(),
                "_words": kept,
            }
        result.append({**segment, "_audio_retry": True})
    return result


def prefix_before_problem(segments, problem):
    prefix = list(segments[: problem.segment])
    segment = segments[problem.segment]
    words = aligned_words(segment)
    restart = segment["start"]
    if words:
        count = 0
        for index, word in enumerate(words):
            length = len(tokens(word["word"]))
            if count + length > problem.token:
                restart = word["start"]
                if index:
                    kept = words[:index]
                    matches = tokens(segment["text"])
                    text = segment["text"][: matches[count].start()].strip()
                    if text and kept[-1]["end"] > segment["start"]:
                        prefix.append(
                            {
                                **segment,
                                "end": kept[-1]["end"],
                                "text": text,
                                "_words": kept,
                            }
                        )
                    else:
                        restart = segment["start"]
                break
            count += length
    # A provider may overlap segments: roll back rather than trim timestamps arbitrarily.
    while prefix and prefix[-1]["end"] > restart + 0.001:
        restart = min(restart, prefix.pop()["start"])
    return prefix, max(0, restart)


def safe_window_prefix(segments, limit):
    result = []
    for segment in segments:
        if segment["end"] <= limit:
            result.append(segment)
            continue
        words = aligned_words(segment)
        if words:
            kept = []
            for word in words:
                if word["end"] > limit:
                    break
                kept.append(word)
            if kept:
                result.append(
                    {
                        **segment,
                        "end": kept[-1]["end"],
                        "text": "".join(w["word"] for w in kept).strip(),
                        "_words": kept,
                    }
                )
        break
    return result


def recover_segments(initial, duration, retry, *, options=None, report=None):
    """retry(start,end,attempt) returns relative segments plus the actual crop offset."""
    options = options or RecoveryOptions.from_env()
    report = report or (lambda *args: None)
    if not math.isfinite(duration) or duration < 0:
        raise ValueError("Duração inválida para recuperação STT.")
    accepted = []
    detector = RepetitionDetector(options)
    problem = None
    try:
        for raw in initial:
            segment = segment_dict(raw)
            if not segment["text"]:
                continue
            accepted.append(segment)
            problem = detector.feed(segment, len(accepted) - 1)
            if problem:
                break
    finally:
        if problem and hasattr(initial, "close"):
            initial.close()
    if not problem:
        return [
            {**{k: s[k] for k in ("start", "end", "text")}, "id": i}
            for i, s in enumerate(accepted)
        ]
    repairs = 0
    attempts = {}
    windows = 0
    max_windows = math.ceil(
        duration / options.window_seconds
    ) * 4 + options.max_repairs * (options.max_retries + 1)
    while problem:
        accepted, start = prefix_before_problem(accepted, problem)
        if start >= duration - 0.00001:
            raise RepetitionRecoveryError(
                "Repetição sem áudio restante com timestamps válidos para recuperação."
            )
        repairs += 1
        position = round(start, 3)
        attempts[position] = attempts.get(position, 0) + 1
        if repairs > options.max_repairs or attempts[position] > options.max_retries:
            raise RepetitionRecoveryError(
                f"Repetição persistente em {start:.3f}s; limite de recuperação atingido. Nenhuma transcrição parcial foi retornada como completa."
            )
        logging.warning(
            "[STT_RECOVERY] Repetição suspeita em %.3fs; preservados %d segmentos, tentativa %d.",
            start,
            len(accepted),
            attempts[position],
        )
        report("recovering", start, duration)
        frontier = start
        while frontier < duration - 0.00001:
            end = min(
                duration,
                frontier
                + max(5, options.window_seconds / (2 ** (attempts[position] - 1))),
            )
            windows += 1
            if windows > max_windows:
                raise RepetitionRecoveryError(
                    "Limite global de janelas de recuperação atingido; transcrição não concluída."
                )
            response = retry(frontier, end, attempts[position])
            offset = float(response.get("offset", frontier))
            new = []
            detector = RepetitionDetector(options)
            for index, segment in enumerate(accepted):
                detector.feed(segment, index)
            relative = response["segments"]
            problem = None
            try:
                for raw in relative:
                    segment = segment_dict(raw, offset)
                    if not segment["text"]:
                        continue
                    if (
                        segment["start"] < frontier - 0.002
                        or segment["end"] > end + 0.1
                        or segment["end"] < segment["start"]
                        or (new and segment["start"] < new[-1]["start"])
                    ):
                        raise RepetitionRecoveryError(
                            "Timestamps inválidos na recuperação STT."
                        )
                    new.append(segment)
                    if len(new) > 10000:
                        raise RepetitionRecoveryError(
                            "Provider excedeu o limite de segmentos em uma janela de recuperação."
                        )
                    problem = detector.feed(segment, len(accepted) + len(new) - 1)
                    if problem:
                        break
            finally:
                if hasattr(relative, "close"):
                    relative.close()
            combined = accepted + new
            if problem:
                accepted = combined
                break
            if end >= duration - 0.00001:
                accepted = combined
                frontier = duration
                report("transcribing", frontier, duration)
                break
            if not new:
                frontier = end
            else:
                safe = safe_window_prefix(new, end - 0.75)
                if safe and safe[-1]["end"] > frontier + 0.001:
                    accepted.extend(safe)
                    frontier = safe[-1]["end"]
                elif new[0]["start"] > frontier + 0.001:
                    frontier = new[0]["start"]
                else:
                    raise RepetitionRecoveryError(
                        f"Não foi possível encontrar uma emenda segura em {frontier:.3f}s, sem cortar uma fala."
                    )
            report("transcribing", frontier, duration)
    return [
        {"id": i, **{k: s[k] for k in ("start", "end", "text")}}
        for i, s in enumerate(accepted)
    ]
