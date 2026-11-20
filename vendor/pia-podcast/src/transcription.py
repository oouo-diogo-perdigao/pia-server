"""Validation and subtitle rendering for provider-produced segment timestamps."""

import math
import logging
from bisect import bisect_right


def repair_point_segments(segments, duration):
    """Give a provider's point annotation a 20-ms technical display interval.

    Starts and positive intervals never move. Prefer the next distinct start as
    a boundary. At EOF use the existing 100-ms codec tolerance, never change
    the measured duration, and expose the correction separately from alignment.
    """
    starts = [segment["start"] for segment in segments]
    repaired = []
    adjustments = []
    for index, segment in enumerate(segments):
        if segment["start"] == segment["end"]:
            start = segment["start"]
            following = bisect_right(starts, start)
            limit = starts[following] if following < len(starts) else duration
            if limit <= start:
                limit = duration + 0.1
            end = min(start + 0.02, limit)
            if end <= start:
                raise ValueError(
                    f"Segmento {index}: sem espaço para corrigir duração zero (start={start}, duration={duration})."
                )
            segment = {**segment, "end": end}
            adjustments.append(
                {
                    "id": segment.get("id", index),
                    "original_end": start,
                    "end": end,
                    "reason": "zero_duration",
                }
            )
        repaired.append(segment)
    return repaired, adjustments


def timed_result(result):
    """Reject missing/invalid timing, including text incorrectly marked as silence."""
    duration = result.get("duration")
    segments = result.get("segments")
    if (
        not isinstance(duration, (int, float))
        or not math.isfinite(duration)
        or duration < 0
    ):
        raise ValueError("Duração real do áudio indisponível.")
    if not isinstance(segments, list) or (result.get("text") and not segments):
        raise ValueError("Provider não retornou timestamps reais para o texto.")
    normalized = []
    previous = 0.0
    for index, segment in enumerate(segments):
        if not isinstance(segment, dict):
            raise ValueError("Provider retornou um segmento inválido.")
        start, end = segment.get("start"), segment.get("end")
        if (
            not isinstance(start, (int, float))
            or not isinstance(end, (int, float))
            or not math.isfinite(start)
            or not math.isfinite(end)
            or isinstance(start, bool)
            or isinstance(end, bool)
            or start < 0
            or start < previous
            or end < start
            or end > duration + 0.1
        ):
            raise ValueError(
                f"Segmento {index}: timestamps inválidos (start={start!r}, end={end!r}, duration={duration!r}, início anterior={previous!r})."
            )
        text = str(segment.get("text") or "").strip()
        if text:
            normalized.append(
                {"id": len(normalized), "start": start, "end": end, "text": text}
            )
        previous = start
    if result.get("text") and not normalized:
        raise ValueError("Provider não retornou segmentos com fala.")
    normalized, adjustments = repair_point_segments(normalized, duration)
    response = {**result, "segments": normalized}
    if adjustments:
        response["timestamp_adjustments"] = [
            *result.get("timestamp_adjustments", []),
            *adjustments,
        ]
        logging.warning(
            "[STT_TIMING] %d segmento(s) com duração zero receberam intervalo técnico de até 20 ms; alinhamento não foi reexecutado.",
            len(adjustments),
        )
    return response


def subtitle_timestamp(seconds, separator):
    milliseconds = round(seconds * 1000)
    hours, milliseconds = divmod(milliseconds, 3600000)
    minutes, milliseconds = divmod(milliseconds, 60000)
    seconds, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02}{separator}{milliseconds:03}"


def render_subtitles(segments, response_format):
    separator = "," if response_format == "srt" else "."
    cues = []
    for i, segment in enumerate(segments, 1):
        start = subtitle_timestamp(segment["start"], separator)
        end = subtitle_timestamp(segment["end"], separator)
        # Empty lines delimit cues; preserve text while preventing accidental cue breaks.
        text = " ".join(segment["text"].splitlines()).strip()
        cues.append(f"{i}\n{start} --> {end}\n{text}\n\n")
    return ("WEBVTT\n\n" if response_format == "vtt" else "") + "".join(cues)
