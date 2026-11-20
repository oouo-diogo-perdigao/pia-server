"""Transcrição de arquivos completos pela PIA com timestamps reais."""

import math
import hashlib
import json
import logging
from dataclasses import replace
import threading
import time
import uuid
from podcast_automation.ui_events import emit
from contextlib import contextmanager
import subprocess
import tempfile
import mimetypes
import os
from pathlib import Path
from types import SimpleNamespace

import requests
from src.app_access import current, headers
from src.stt_recovery import find_repetition, RecoveryOptions
from src.transcription import timed_result
from src.config_paths import BASE_DIR
from src.resource_plugins import save_json

CHECKPOINT_ROOT = BASE_DIR / "cache/Apps/podcast_automation/transcription-responses"


class PiaTranscription:
    def __init__(self):
        context = current()
        self.url = context["url"].rstrip("/") + "/v1/audio/transcriptions"
        self.headers = headers()
        self.model = "local/medium"  # OpenAI-compatible model field, explicitly selects PIA local Whisper.
        self.timeout = float(context.get("stt_timeout", context.get("timeout", 3600)))
        self.max_bytes = int(context["max_upload_bytes"])

    @staticmethod
    def parse_segments(data):
        """Valida a resposta inteira antes de disponibilizar qualquer segmento."""
        try:
            if not isinstance(data, dict) or not isinstance(data.get("text"), str):
                raise ValueError("Campo text ausente ou inválido")
            duration = data["duration"]
            if isinstance(duration, bool) or not isinstance(duration, (int, float)):
                raise ValueError("Duração inválida")
            if not math.isfinite(duration) or duration < 0:
                raise ValueError("Duração inválida")
            segments = data["segments"]
            if not isinstance(segments, list) or (
                data["text"].strip() and not segments
            ):
                raise ValueError("Texto sem segmentos temporais")
            # Share the route's correction policy, also accepting old servers
            # that returned point annotations without a positive interval.
            data = timed_result(data)
            segments = data["segments"]
            result = []
            previous_start = 0.0
            for segment in segments:
                start, end, text = segment["start"], segment["end"], segment["text"]
                if not isinstance(text, str):
                    raise ValueError("Texto do segmento inválido")
                if any(
                    isinstance(t, bool)
                    or not isinstance(t, (int, float))
                    or not math.isfinite(t)
                    for t in (start, end)
                ):
                    raise ValueError("Timestamp inválido")
                if (
                    start < previous_start
                    or start < 0
                    or end <= start
                    or end > duration + 0.1
                ):
                    raise ValueError("Intervalo temporal inválido")
                previous_start = start
                if text.strip():
                    result.append(SimpleNamespace(start=start, end=end, text=text))
            if data["text"].strip() and not result:
                raise ValueError("Texto sem segmentos de fala")
            # Six words is a server-side *suspicion*, not proof that speech is
            # invalid. The server may have confirmed a short repeat from audio.
            options = RecoveryOptions.from_env()
            options = replace(options, repetitions=max(13, options.repetitions * 2 + 1))
            if find_repetition(
                [{"start": s.start, "end": s.end, "text": s.text} for s in result],
                options,
            ):
                raise RuntimeError(
                    "PIA retornou uma repetição suspeita não recuperada. Reinicie/atualize a PIA antes de continuar."
                )
            return result
        except (KeyError, TypeError, ValueError) as exc:
            raise RuntimeError(
                f"PIA: resposta verbose_json inválida ou sem timestamps reais: {exc}. "
                "A falha ocorreu na validação da resposta, não no envio do áudio."
            ) from exc

    def response_path(self, path):
        digest = hashlib.sha256()
        with Path(path).open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        scope = json.dumps(
            {"audio": digest.hexdigest(), "model": self.model, "language": "pt"},
            sort_keys=True,
        )
        return CHECKPOINT_ROOT / (hashlib.sha256(scope.encode()).hexdigest() + ".json")

    def read_response(self, data, checkpoint):
        try:
            return self.parse_segments(data)
        except RuntimeError as exc:
            if not checkpoint.is_file():
                raise
            raise RuntimeError(
                f"{exc}\nResposta completa preservada em {checkpoint}. "
                "Ela poderá ser validada novamente sem enviar o áudio. "
                "Para solicitar uma nova transcrição, remova somente esse arquivo de resposta."
            ) from exc

    @contextmanager
    def prepare_audio(self, path, duration=None):
        """Cópia temporária para STT; preserva pausas e a linha do tempo original."""
        path = Path(path)
        # 64 kbps = 8000 bytes/s; faixas FLAC longas dispensam a conversão.
        if (
            path.suffix.lower() == ".flac"
            and duration is not None
            and duration * 8000 >= 25000000
        ):
            print(f"Áudio longo: enviando FLAC original à PIA: {path.name}", flush=True)
            yield path
            return
        cache = CHECKPOINT_ROOT.with_name("transcription")
        cache.mkdir(parents=True, exist_ok=True)
        emit(
            "progress",
            **{
                **getattr(self, "progress_context", {}),
                "state": "preparing",
                "label": "Preparando áudio para o Whisper medium",
                "percent": 0,
            },
        )
        with tempfile.TemporaryDirectory(prefix="stt-", dir=cache) as directory:
            upload = Path(directory) / "transcricao.mp3"
            print(
                f"Preparando áudio para transcrição: {path.name} para MP3 mono 16 kHz / 64 kbps",
                flush=True,
            )
            result = subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-nostdin",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(path),
                    "-map",
                    "0:a:0",
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-c:a",
                    "libmp3lame",
                    "-b:a",
                    "64k",
                    "-map_metadata",
                    "-1",
                    str(upload),
                ],
                capture_output=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            if result.returncode != 0:
                raise RuntimeError(
                    f"Falha ao preparar MP3 para transcrição: {result.stderr.strip()}"
                )
            if upload.stat().st_size < 25000000:
                yield upload
            elif path.suffix.lower() == ".flac":
                print("MP3 atingiu 25 MB; enviando FLAC original à PIA.", flush=True)
                yield path
            else:
                flac = Path(directory) / "transcricao.flac"
                result = subprocess.run(
                    [
                        "ffmpeg",
                        "-hide_banner",
                        "-nostdin",
                        "-loglevel",
                        "error",
                        "-y",
                        "-i",
                        str(path),
                        "-map",
                        "0:a:0",
                        "-vn",
                        "-c:a",
                        "flac",
                        str(flac),
                    ],
                    capture_output=True,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                )
                if result.returncode != 0:
                    raise RuntimeError(
                        f"Falha ao preparar FLAC: {result.stderr.strip()}"
                    )
                yield flac

    def transcribe(self, path, duration=None):
        """Envia MP3 abaixo de 25 MB; para faixas maiores usa FLAC, sem cortes."""
        with self.prepare_audio(path, duration) as upload:
            return self.transcribe_file(upload)

    def transcribe_file(self, path):
        """Valida o limite sobre o arquivo escolhido e consome os tempos da PIA."""
        path = Path(path)
        max_bytes = self.max_bytes
        if max_bytes > 0 and path.stat().st_size + 65536 > max_bytes:
            raise RuntimeError(
                f"PIA: arquivo {path.name} tem {path.stat().st_size / 1024**2:.1f} MiB; "
                f"o limite configurado é {max_bytes / 1024**2:g} MiB por requisição. "
                "Ajuste o limite de upload nas configurações da PIA ou use áudio comprimido menor."
            )
        checkpoint = self.response_path(path)
        if checkpoint.is_file():
            try:
                with checkpoint.open(encoding="utf-8") as cached:
                    data = json.load(cached)
            except (OSError, ValueError) as exc:
                raise RuntimeError(
                    f"Não foi possível ler a resposta preservada em {checkpoint}: {exc}"
                ) from exc
            print(
                f"Reutilizando resposta STT preservada: {path.name}; sem enviar o áudio novamente.",
                flush=True,
            )
            self.last_speed = 0
            return iter(self.read_response(data, checkpoint))
        print(
            f"Transcrevendo pela PIA: {path.name} ({path.stat().st_size / 1024**2:.1f} MiB); aguardando resposta...",
            flush=True,
        )
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        identity = uuid.uuid4().hex
        stopped = threading.Event()
        started = time.monotonic()

        def follow():
            while not stopped.wait(1):
                try:
                    result = requests.get(
                        self.url + "/progress/" + identity,
                        headers=self.headers,
                        timeout=5,
                    )
                    try:
                        if result.status_code == 200:
                            event = result.json()
                            payload = {k: v for k, v in event.items() if k != "id"}
                            payload["speed"] = max(
                                0, float(payload.get("processed") or 0)
                            ) / max(0.001, time.monotonic() - started)
                            emit(
                                "progress",
                                **{**payload, **getattr(self, "progress_context", {})},
                            )
                            if event.get("state") in ("completed", "error"):
                                return
                    finally:
                        result.close()
                except requests.RequestException:
                    pass

        threading.Thread(
            target=follow, daemon=True, name="podcast-stt-progress"
        ).start()
        with path.open("rb") as audio:
            try:
                response = requests.post(
                    self.url,
                    headers={**self.headers, "X-PIA-Transcription-ID": identity},
                    files={"file": (path.name, audio, mime)},
                    data={
                        "model": self.model,
                        "language": "pt",
                        "response_format": "verbose_json",
                    },
                    timeout=self.timeout,
                )
            except requests.RequestException as exc:
                raise RuntimeError(
                    "Não foi possível comunicar com a PIA para transcrever o áudio."
                ) from exc
            finally:
                stopped.set()
        if response.status_code >= 400:
            detail = ""
            try:
                message = response.json().get("error", {}).get("message")
                if isinstance(message, str):
                    detail = " " + message
            except (ValueError, AttributeError):
                pass
            raise RuntimeError(
                f"PIA: transcrição retornou HTTP {response.status_code}.{detail}"
            )
        try:
            data = response.json()
        except ValueError as exc:
            raise RuntimeError(
                "PIA: resposta de transcrição não contém JSON válido."
            ) from exc
        # Persist before validation: a contract problem must not discard hours
        # of completed decoding. The original provider response stays untouched.
        try:
            save_json(checkpoint, data)
        except OSError as exc:
            logging.warning(
                "Não foi possível preservar a resposta STT em %s: %s. A validação continuará.",
                checkpoint,
                exc,
            )
        segments = self.read_response(data, checkpoint)
        self.last_speed = max(0, float(data.get("duration") or 0)) / max(
            0.001, time.monotonic() - started
        )
        return iter(segments)
