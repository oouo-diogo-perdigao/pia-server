"""Encurta somente pausas longas e registra a transformação da linha do tempo."""

import json
import math
import re
import subprocess
from pathlib import Path


def retained_ranges(duration, silences, keep):
    ranges = []
    cursor = 0.0
    for start, end in silences:
        start, end = max(cursor, start), min(duration, end)
        if end - start <= keep:
            continue
        left, right = start + keep / 2, end - keep / 2
        if left > cursor:
            ranges.append([cursor, left])
        cursor = right
    if cursor < duration:
        ranges.append([cursor, duration])
    return ranges or [[0.0, duration]]


def map_time(timestamp, ranges):
    elapsed = 0.0
    for start, end in ranges:
        if timestamp < start:
            return elapsed
        if timestamp <= end:
            return elapsed + timestamp - start
        elapsed += end - start
    return elapsed


def edit_pauses(source, duration, config, run_ffmpeg):
    numbers = [
        float(config[k])
        for k in (
            "silence_threshold_db",
            "minimum_silence_seconds",
            "keep_silence_seconds",
            "fade_seconds",
        )
    ]
    threshold, minimum, keep, fade = numbers
    if (
        not all(math.isfinite(n) for n in numbers)
        or threshold >= 0
        or not 0 <= fade <= 0.05
        or keep < 0.1
        or minimum <= keep
    ):
        raise ValueError(
            "Áudio: limiar negativo, pausa mínima maior que a margem (>=0.1s) e fade de 0 a 0.05s são obrigatórios."
        )
    identity = [[0.0, duration]]
    if not config.get("remove_silence", False):
        return source, identity
    result = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostdin",
            "-i",
            str(source),
            "-af",
            f"silencedetect=noise={threshold}dB:d={minimum}",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        text=True,
        check=True,
    )
    silences = []
    start = None
    for line in result.stderr.splitlines():
        match = re.search(r"silence_start: ([\d.]+)", line)
        if match:
            start = float(match.group(1))
        match = re.search(r"silence_end: ([\d.]+)", line)
        if match and start is not None:
            silences.append((start, float(match.group(1))))
            start = None
    if start is not None:
        silences.append((start, duration))
    ranges = retained_ranges(duration, silences, keep)
    if ranges == identity:
        return source, ranges
    # Processa PCM antes da única codificação MP3 final; fades ficam dentro das pausas.
    output = Path(source).with_suffix(".edited.wav")
    script = Path(source).with_suffix(".filters.txt")
    lines = []
    labels = "".join(f"[part{i}]" for i in range(len(ranges)))
    lines.append(f"[0:a]asplit={len(ranges)}{labels}")
    for i, (a, b) in enumerate(ranges):
        edge = min(fade, (b - a) / 2)
        lines.append(
            f"[part{i}]atrim=start={a}:end={b},asetpts=PTS-STARTPTS,"
            f"afade=t=in:d={edge},afade=t=out:st={b - a - edge}:d={edge}[out{i}]"
        )
    lines.append(
        "".join(f"[out{i}]" for i in range(len(ranges)))
        + f"concat=n={len(ranges)}:v=0:a=1[edited]"
    )
    script.write_text(";\n".join(lines), encoding="utf-8")
    try:
        run_ffmpeg(
            [
                "-i",
                str(source),
                "-/filter_complex",
                str(script),
                "-map",
                "[edited]",
                "-c:a",
                "pcm_s16le",
                str(output),
            ],
            "Editando pausas",
            duracao=sum(b - a for a, b in ranges),
        )
    finally:
        script.unlink(missing_ok=True)
    return str(output), ranges


def save_timeline(path, ranges):
    Path(path).write_text(json.dumps(ranges), encoding="utf-8")
