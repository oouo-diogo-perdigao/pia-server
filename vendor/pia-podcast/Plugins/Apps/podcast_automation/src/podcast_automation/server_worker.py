"""Worker Python em duas fases (prepare / publish) para processamento Pro no servidor.

Reutiliza os componentes de Podcast Automation sem alterar o fluxo local do desktop.
Protocolo CLI:
  - Comando: python -m podcast_automation.server_worker
  - Entrada: 1 objeto JSON via stdin (UTF-8)
  - Saida:   eventos JSON por linha (NDJSON) no stdout; logs internos em stderr
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from . import (
    audioManager as audio_manager_mod,
    geradorResumoSessao as summary_mod,
    feedCache as feed_cache_mod,
    main as main_mod,
    notification as notification_mod,
    objectStorageManager as storage_mod,
    piaTranscription as transcription_mod,
    rssTranscriptionUpdate as rss_mod,
    settings as settings_mod,
    transcritorWhisper as whisper_mod,
)
from .ui_events import STAGES


SECRET_FIELDS = frozenset(
    {
        "accessKeyId",
        "secretAccessKey",
        "sessionToken",
        "token",
        "apiKey",
        "password",
        "authorization",
    }
)


class WorkerError(RuntimeError):
    """Erro estruturado retornado pelo worker no evento NDJSON de erro."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        missing_config: list[str] | None = None,
    ):
        super().__init__(message)
        self.code = code
        self.missing_config = list(missing_config or [])


def sanitize_message(text: str, secrets: tuple[str, ...] = ()) -> str:
    cleaned = str(text or "Erro interno no worker.")
    for secret in secrets:
        if isinstance(secret, str) and len(secret) >= 4:
            cleaned = cleaned.replace(secret, "[REDACTED]")
    cleaned = re.sub(
        r"(?i)(bearer\s+|sk-[a-z0-9_-]+|AKIA[0-9A-Z]{16})([^\s\"']+)?",
        "[REDACTED]",
        cleaned,
    )
    return cleaned.strip()


def _extract_secrets(payload: Any) -> tuple[str, ...]:
    found: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if key in SECRET_FIELDS and isinstance(value, str) and value.strip():
                    found.append(value.strip())
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(payload)
    return tuple(dict.fromkeys(found))


def _atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(tmp, path)


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _safe_extract_zip(archive: Path, destination: Path) -> Path:
    if destination.is_dir() and any(destination.iterdir()):
        return destination
    destination.mkdir(parents=True, exist_ok=True)
    dest_root = destination.resolve()
    with zipfile.ZipFile(archive, "r") as zf:
        for member in zf.infolist():
            target = (destination / member.filename).resolve()
            if not target.is_relative_to(dest_root):
                raise WorkerError(
                    "invalid_input",
                    "O arquivo ZIP contém um caminho fora da pasta de trabalho.",
                )
        zf.extractall(destination)
    return destination


def _default_config_overlay(config: dict[str, Any]) -> dict[str, Any]:
    publication = {
        "brand": "PIA",
        "language": "pt-BR",
        "unpublished_prefix": "nao-publicados",
        **(config.get("publication") if isinstance(config.get("publication"), dict) else {}),
    }
    processing = {
        "minimum_session_seconds": 1800,
        "duplicate_max_bytes": 100000,
        "duplicate_max_seconds": 3600,
        **(config.get("processing") if isinstance(config.get("processing"), dict) else {}),
    }
    audio = {
        **(config.get("audio") if isinstance(config.get("audio"), dict) else {}),
    }
    outputs = {
        "resumo.json": True,
        "srt": True,
        "txt": True,
        "vtt": True,
        **(config.get("outputs") if isinstance(config.get("outputs"), dict) else {}),
        "mp3": True,
    }
    return {
        **config,
        "nomes_reais": config.get("nomes_reais") if isinstance(config.get("nomes_reais"), dict) else {},
        "campaign_details": config.get("campaign_details") if isinstance(config.get("campaign_details"), dict) else {},
        "publication": publication,
        "processing": processing,
        "audio": audio,
        "outputs": outputs,
        "discord_users": config.get("discord_users") if isinstance(config.get("discord_users"), dict) else {},
    }


def validate_account_payload(account: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    if not isinstance(account, dict):
        raise WorkerError(
            "missing_config",
            "Para processar no servidor, configure bucket e campanha.",
            missing_config=["bucket", "campanha"],
        )

    raw_config = account.get("config")
    raw_storage = account.get("storage")
    missing: list[str] = []

    storage = raw_storage if isinstance(raw_storage, dict) else {}
    bucket = str(storage.get("bucket") or "").strip()
    if not bucket:
        missing.append("bucket")

    config = _default_config_overlay(raw_config if isinstance(raw_config, dict) else {})
    campaigns = config.get("campaign_details")
    if not isinstance(campaigns, dict) or not campaigns:
        missing.append("campanha")

    if missing:
        raise WorkerError(
            "missing_config",
            "Para processar no servidor, configure " + " e ".join(missing) + ".",
            missing_config=missing,
        )

    folders: set[str] = set()
    for narrator, table in campaigns.items():
        if (
            not isinstance(table, dict)
            or not str(table.get("Campanha") or "").strip()
            or not str(table.get("rss_key") or "").strip()
        ):
            raise WorkerError(
                "missing_config",
                f"Configuração de campanha incompleta para {narrator}.",
                missing_config=["campanha"],
            )
        key = str(table["rss_key"]).strip()
        if not key.endswith("/rss.xml") or any(
            part in ("", ".", "..") for part in key.split("/")
        ):
            raise WorkerError(
                "invalid_input",
                f"rss_key inválida para {narrator}: use pasta/rss.xml sem caminhos relativos.",
            )
        folder = key.rsplit("/", 1)[0]
        if folder in folders:
            raise WorkerError(
                "invalid_input",
                f"Mais de uma mesa referencia a pasta {folder}.",
            )
        folders.add(folder)

    return config, storage


@contextlib.contextmanager
def scoped_podcast_config(config: dict[str, Any], work_dir: Path):
    """Isola get_config() e output_formats() para a conta em execucao sem tocar no perfil local."""
    outputs = {
        **{name: True for name in ("resumo.json", "srt", "txt", "vtt")},
        **(config.get("outputs") or {}),
        "mp3": True,
    }
    patched: list[tuple[Any, str, Any]] = [
        (transcription_mod, "CHECKPOINT_ROOT", transcription_mod.CHECKPOINT_ROOT),
        (feed_cache_mod, "BASE_DIR", feed_cache_mod.BASE_DIR),
    ]
    transcription_mod.CHECKPOINT_ROOT = work_dir / "cache/Apps/podcast_automation/transcription-responses"
    feed_cache_mod.BASE_DIR = work_dir
    targets = (
        settings_mod,
        main_mod,
        audio_manager_mod,
        summary_mod,
        notification_mod,
        storage_mod,
        rss_mod,
        whisper_mod,
    )
    for mod in targets:
        if hasattr(mod, "get_config"):
            patched.append((mod, "get_config", getattr(mod, "get_config")))
            setattr(mod, "get_config", lambda cfg=config: cfg)
        if hasattr(mod, "output_formats"):
            patched.append((mod, "output_formats", getattr(mod, "output_formats")))
            setattr(mod, "output_formats", lambda out=outputs: dict(out))
    try:
        yield
    finally:
        for mod, attr, original in reversed(patched):
            setattr(mod, attr, original)


class AccountObjectStorage:
    """Adaptador S3-compativel por conta em memoria (nunca persiste credenciais em disco)."""

    def __init__(self, storage_config: dict[str, Any], brand: str = "PIA"):
        self.bucket = str(storage_config["bucket"]).strip()
        self.endpoint = str(storage_config.get("endpoint") or "").strip()
        self.region = str(storage_config.get("region") or "auto").strip()
        self._public_base = str(storage_config.get("publicUrl") or "").rstrip("/")
        self._brand = brand
        self._access_key = str(storage_config.get("accessKeyId") or "").strip()
        self._secret_key = str(storage_config.get("secretAccessKey") or "").strip()
        self._client = None
        self.identity = {
            "endpoint": self.endpoint,
            "bucket": self.bucket,
            "url": self._public_base,
            "account": str(storage_config.get("accountId") or self.bucket),
        }

    def _s3(self):
        if self._client is None:
            import boto3

            kwargs: dict[str, Any] = {"region_name": self.region}
            if self.endpoint:
                kwargs["endpoint_url"] = self.endpoint
            if self._access_key and self._secret_key:
                kwargs["aws_access_key_id"] = self._access_key
                kwargs["aws_secret_access_key"] = self._secret_key
            self._client = boto3.client("s3", **kwargs)
        return self._client

    def metadata(self) -> dict[str, str]:
        return {
            "uploaded_by": self._brand,
            "source": "PIA Podcast Automation Server Worker",
        }

    def getObject(self, key: str) -> bytes:
        response = self._s3().get_object(Bucket=self.bucket, Key=key)
        return response["Body"].read()

    def getObjectIfExists(self, key: str) -> bytes | None:
        from botocore.exceptions import ClientError

        try:
            return self.getObject(key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in (
                "NoSuchKey",
                "404",
                "NotFound",
            ):
                return None
            raise

    def sendObject(
        self, path: str, key: str, content_type: str = "application/octet-stream"
    ) -> None:
        self._s3().upload_file(
            str(path),
            self.bucket,
            key,
            ExtraArgs={"ContentType": content_type, "Metadata": self.metadata()},
        )

    def putObject(
        self, key: str, data: bytes | str, content_type: str = "application/octet-stream"
    ) -> None:
        body = data.encode("utf-8") if isinstance(data, str) else data
        self._s3().put_object(
            Bucket=self.bucket,
            Key=key,
            Body=body,
            ContentType=content_type,
            Metadata=self.metadata(),
        )

    def list_objects(self, prefix: str) -> list[dict[str, Any]]:
        paginator = self._s3().get_paginator("list_objects_v2")
        items: list[dict[str, Any]] = []
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            items.extend(page.get("Contents", []))
        return items

    def public_url(self, key: str) -> str:
        clean_key = str(key).lstrip("/")
        if self._public_base:
            return f"{self._public_base}/{clean_key}"
        return f"https://{self.bucket}.s3.amazonaws.com/{clean_key}"


def _normalize_suggestions(
    raw_candidates: list[str],
    *,
    initial_title: str = "",
    limit: int = 3,
    fallback_title: str = "",
) -> list[str]:
    seen: set[str] = set()
    if initial_title.strip():
        seen.add(initial_title.strip().casefold())
    suggestions: list[str] = []
    for candidate in raw_candidates:
        clean = re.sub(r"\s+", " ", str(candidate or "")).strip()[:100]
        if not clean:
            continue
        key = clean.casefold()
        if key in seen:
            continue
        seen.add(key)
        suggestions.append(clean)
        if len(suggestions) >= max(1, int(limit)):
            break
    if not suggestions and fallback_title.strip():
        clean = re.sub(r"\s+", " ", fallback_title).strip()[:100]
        if clean.casefold() not in seen:
            suggestions.append(clean)
    return suggestions


def _update_mp3_title_tag(audio_path: Path, title: str) -> None:
    try:
        from mutagen.easyid3 import EasyID3
        from mutagen.id3 import ID3NoHeaderError
    except Exception:
        return
    if not audio_path.is_file():
        return
    try:
        tags = EasyID3(str(audio_path))
    except ID3NoHeaderError:
        tags = EasyID3()
    except Exception:
        return
    tags["title"] = title
    tags.save(str(audio_path))


def _update_summary_files_title(
    state: dict[str, Any],
    winner_title: str,
) -> None:
    resumo_json_str = state.get("artifacts", {}).get("resumo_json_path")
    if resumo_json_str:
        resumo_path = Path(resumo_json_str)
        if resumo_path.is_file():
            try:
                data = json.loads(resumo_path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    data["nome_sessao"] = winner_title
                    _atomic_write_json(resumo_path, data)
            except json.JSONDecodeError:
                pass

    roteiro_str = state.get("artifacts", {}).get("roteiro_path")
    if roteiro_str:
        roteiro_path = Path(roteiro_str)
        if roteiro_path.is_file():
            text = roteiro_path.read_text(encoding="utf-8")
            updated = re.sub(
                r"(?m)^Nome da Sessão:.*$",
                f"Nome da Sessão: {winner_title}",
                text,
            )
            if updated != text:
                roteiro_path.write_text(updated, encoding="utf-8")


def _rename_artifacts_for_winner(
    state: dict[str, Any],
    winner_title: str,
    update_audio_tag: Callable[[Path, str], None] = _update_mp3_title_tag,
) -> dict[str, str]:
    artifacts = dict(state.get("artifacts") or {})
    campaign = str(state.get("campaign") or "Sessao")
    season = state.get("season")
    episode = state.get("episode")
    code = (
        f"S{int(season):02d}E{int(episode):02d}"
        if season is not None and episode is not None
        else ""
    )
    stem_parts = [part for part in (campaign, code, winner_title) if part]
    base_name = audio_manager_mod.AudioManager.nome_seguro(" - ".join(stem_parts))

    _update_summary_files_title(state, winner_title)

    suffix_map = (
        ("audio_path", ".mp3"),
        ("srt_path", ".srt"),
        ("vtt_path", ".vtt"),
        ("roteiro_path", ".txt"),
        ("resumo_json_path", ".resumo.json"),
    )
    updated: dict[str, str] = {}
    for key, suffix in suffix_map:
        current_str = artifacts.get(key)
        if not current_str:
            continue
        current = Path(current_str)
        if not current.is_file():
            updated[key] = current_str
            continue
        target = current.parent / f"{base_name}{suffix}"
        if current != target:
            if target.exists():
                target.unlink()
            current.rename(target)
        updated[key] = str(target)

    if updated.get("audio_path"):
        update_audio_tag(Path(updated["audio_path"]), winner_title)

    state["artifacts"] = {**artifacts, **updated}
    return state["artifacts"]


def build_announcement(
    winner_title: str,
    campaign: str,
    links: dict[str, str],
    season: int | None,
    episode: int | None,
    players: list[str] | tuple[str, ...],
    discord_users: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Reproduz exatamente o formato de anuncio de notification.py."""
    text = notification_mod.publication_text(
        winner_title,
        campaign,
        links,
        season,
        episode,
    )
    mapping = discord_users if isinstance(discord_users, dict) else {}
    mentions = list(
        dict.fromkeys(
            str(mapping[player])
            for player in (players or ())
            if player in mapping
            and re.fullmatch(r"[0-9]{1,20}", str(mapping[player]))
        )
    )
    if mentions:
        text += "\n" + " ".join("<@" + identity + ">" for identity in mentions)
    parts = list(notification_mod.message_parts(text, 2000, "Discord"))
    return {
        "text": text,
        "parts": parts,
        "mentions": mentions,
    }


def _add_checkpoint(
    state: dict[str, Any],
    state_path: Path,
    checkpoint: str,
    emit: Callable[[dict[str, Any]], None],
    action: str,
) -> None:
    checkpoints = list(state.get("checkpoints") or [])
    if checkpoint not in checkpoints:
        checkpoints.append(checkpoint)
    state["checkpoints"] = checkpoints
    state["updatedAt"] = datetime.now(timezone.utc).isoformat()
    _atomic_write_json(state_path, state)
    emit(
        {
            "event": "checkpoint",
            "action": action,
            "recordingId": state["recordingId"],
            "checkpoint": checkpoint,
        }
    )


def _emit_stage(
    emit: Callable[[dict[str, Any]], None],
    action: str,
    recording_id: str,
    index: int,
) -> None:
    label = STAGES[index] if 0 <= index < len(STAGES) else f"Etapa {index}"
    emit(
        {
            "event": "stage",
            "action": action,
            "recordingId": recording_id,
            "index": index,
            "stage": label,
        }
    )


def prepare_session(
    payload: dict[str, Any],
    *,
    emit: Callable[[dict[str, Any]], None] = lambda _event: None,
    storage_adapter: Any = None,
    audio_factory: Any = None,
    whisper_factory: Any = None,
    summary_factory: Any = None,
    duration_fn: Callable[[list[str]], float] | None = None,
) -> dict[str, Any]:
    """Fase 1 (prepare): processa audio, transcricao, resumo e sugestoes sem publicar."""
    recording_id = str(payload.get("recordingId") or "").strip()
    archive_raw = str(payload.get("archive") or "").strip()
    work_dir_raw = str(payload.get("workDir") or "").strip()
    if not recording_id or not archive_raw or not work_dir_raw:
        raise WorkerError(
            "invalid_input",
            "Informe recordingId, archive e workDir para prepare.",
        )

    config, storage_cfg = validate_account_payload(payload.get("account"))
    archive = Path(archive_raw)
    if not archive.is_file():
        raise WorkerError(
            "invalid_input",
            f"Arquivo da gravação não encontrado: {archive.name}",
        )

    work_dir = Path(work_dir_raw)
    work_dir.mkdir(parents=True, exist_ok=True)
    state_path = work_dir / "state.json"

    existing = _read_json(state_path)
    if (
        isinstance(existing, dict)
        and existing.get("recordingId") == recording_id
        and existing.get("status") == "prepared"
        and existing.get("artifactId")
    ):
        audio_artifact = existing.get("artifacts", {}).get("audio_path")
        if audio_artifact and Path(audio_artifact).is_file():
            return {
                "recordingId": recording_id,
                "artifactId": existing["artifactId"],
                "statePath": str(state_path),
                "status": "prepared",
                "skipped": False,
                "campaign": existing["campaign"],
                "season": existing.get("season"),
                "episode": existing.get("episode"),
                "rssKey": existing["rssKey"],
                "players": existing.get("players", []),
                "initialTitle": existing.get("initialTitle", ""),
                "suggestions": existing.get("suggestions", []),
                "summary": existing.get("summary", {"quick": "", "full": ""}),
                "checkpoints": existing.get("checkpoints", []),
            }

    state: dict[str, Any] = {
        "version": 1,
        "recordingId": recording_id,
        "accountId": str((payload.get("account") or {}).get("id") or ""),
        "archiveName": archive.name,
        "status": "preparing",
        "published": False,
        "checkpoints": [],
        "artifacts": {},
    }

    storage = storage_adapter or AccountObjectStorage(
        storage_cfg,
        brand=str(config["publication"].get("brand") or "PIA"),
    )
    recording_metadata = dict(payload.get("recordingMetadata") or {})
    suggestion_count = max(1, int(payload.get("suggestionCount") or 3))

    with scoped_podcast_config(config, work_dir):
        _emit_stage(emit, "prepare", recording_id, 1)
        extracted_dir = _safe_extract_zip(archive, work_dir / "extracted")
        state["extractedDir"] = str(extracted_dir)
        _add_checkpoint(state, state_path, "extracted", emit, "prepare")

        file_metadata = audio_manager_mod.AudioManager.ler_metadados_da_gravacao(
            extracted_dir
        )
        merged_metadata = {
            **(file_metadata if isinstance(file_metadata, dict) else {}),
            **recording_metadata,
        }

        build_audio = audio_factory or audio_manager_mod.AudioManager
        audio = build_audio(
            archive.name,
            str(extracted_dir),
            config["nomes_reais"],
            config["campaign_details"],
            storage,
            **({"recording_metadata": merged_metadata} if merged_metadata else {}),
        )

        get_duration = duration_fn or audio_manager_mod.AudioManager.obter_duracao_audio
        duracao = float(get_duration(audio.arquivos_participantes))
        min_seconds = float(config["processing"].get("minimum_session_seconds", 1800))
        if duracao < min_seconds:
            state["status"] = "skipped"
            state["skipReason"] = "Sessão abaixo da duração mínima"
            _atomic_write_json(state_path, state)
            return {
                "recordingId": recording_id,
                "artifactId": None,
                "statePath": str(state_path),
                "status": "skipped",
                "skipped": True,
                "reason": state["skipReason"],
                "campaign": getattr(audio, "campanha", ""),
                "season": getattr(audio, "session", None),
                "episode": getattr(audio, "episode", None),
                "rssKey": getattr(audio, "rss", ""),
                "players": list(getattr(audio, "jogadores", ()) or ()),
                "initialTitle": str(merged_metadata.get("sessionTitle") or "").strip(),
                "suggestions": [],
                "summary": {"quick": "", "full": ""},
                "checkpoints": state["checkpoints"],
            }

        _emit_stage(emit, "prepare", recording_id, 2)
        mix_path = audio.mix()
        _emit_stage(emit, "prepare", recording_id, 3)
        audio_path = audio.build()

        item: dict[str, Any] = {
            "name": archive.name,
            "pasta_extraida": str(extracted_dir),
            "mix_path": str(mix_path),
            "audio_path": str(audio_path),
            "edit_timeline": getattr(audio, "edit_timeline", None),
            "arquivos_participantes": getattr(audio, "arquivos_participantes", []),
            "grupos_transcricao": getattr(audio, "grupos_transcricao", {}),
            "campanha": audio.campanha,
            "narrador": audio.narrador,
            "personagens": list(audio.personagens),
            "jogadores": list(audio.jogadores),
            "season": audio.session,
            "episode": audio.episode,
            "ouvintes": list(getattr(audio, "ouvintes", []) or []),
            "rss_key": audio.rss,
        }

        state["campaign"] = item["campanha"]
        state["narrator"] = item["narrador"]
        state["characters"] = item["personagens"]
        state["players"] = item["jogadores"]
        state["listeners"] = item["ouvintes"]
        state["season"] = item["season"]
        state["episode"] = item["episode"]
        state["rssKey"] = item["rss_key"]
        state["artifacts"]["mix_path"] = item["mix_path"]
        state["artifacts"]["audio_path"] = item["audio_path"]
        _add_checkpoint(state, state_path, "audio_built", emit, "prepare")

        formats = settings_mod.output_formats()
        transcribe = any(
            formats.get(name) for name in ("srt", "vtt", "txt", "resumo.json")
        )
        if transcribe:
            build_whisper = whisper_factory or whisper_mod.TranscritorWhisper
            whisper = build_whisper(config["nomes_reais"], config["campaign_details"])
            try:
                _emit_stage(emit, "prepare", recording_id, 4)
                whisper.carregar_pasta(item)
                whisper.build()
                _emit_stage(emit, "prepare", recording_id, 5)
                if formats.get("srt"):
                    item["srt_path"] = str(whisper.gravar_srt())
                    state["artifacts"]["srt_path"] = item["srt_path"]
                if formats.get("vtt"):
                    item["vtt_path"] = str(whisper.gravar_vtt())
                    state["artifacts"]["vtt_path"] = item["vtt_path"]
                if formats.get("txt") or formats.get("resumo.json"):
                    item["roteiro_path"] = str(whisper.gravar_roteiro())
                    state["artifacts"]["roteiro_path"] = item["roteiro_path"]
            finally:
                if hasattr(whisper, "descarregar_modelo"):
                    whisper.descarregar_modelo()
            _add_checkpoint(state, state_path, "transcribed", emit, "prepare")

        initial_title = str(merged_metadata.get("sessionTitle") or "").strip()
        fallback_title = f"Sessão {item['season']} · Episódio {item['episode']}"
        raw_suggestions: list[str] = []
        quick_summary = ""
        full_summary = ""

        if formats.get("resumo.json") and item.get("roteiro_path"):
            _emit_stage(emit, "prepare", recording_id, 6)
            build_summary = summary_factory or summary_mod.GeradorResumoSessao
            gerador = build_summary(
                campanha=item["campanha"],
                narrador=item["narrador"],
                personagens=item["personagens"],
                jogadores=item["jogadores"],
                ouvintes=item["ouvintes"],
                roteiro_path=item["roteiro_path"],
                obj_storage=storage,
                rss_key=item["rss_key"],
            )
            generated_title, quick_summary, full_summary = gerador.gerar_resumo()
            item["resumo_rapido"] = quick_summary
            item["resumo_completo"] = full_summary
            item["nome_sessao"] = initial_title or generated_title or fallback_title
            if formats.get("txt"):
                gerador.incluir_resumo_no_roteiro(item)
            if getattr(gerador, "resumo_json_path", None):
                state["artifacts"]["resumo_json_path"] = str(gerador.resumo_json_path)

            extra_suggestions = getattr(gerador, "sugestoes_titulo", None)
            if isinstance(extra_suggestions, list):
                raw_suggestions.extend(str(s) for s in extra_suggestions)
            if generated_title:
                raw_suggestions.insert(0, str(generated_title))
            _add_checkpoint(state, state_path, "summarized", emit, "prepare")

        suggestions = _normalize_suggestions(
            raw_suggestions,
            initial_title=initial_title,
            limit=suggestion_count,
            fallback_title=fallback_title,
        )

        digest = hashlib.sha256(
            f"{recording_id}:{archive.name}:{item['campanha']}:{item['season']}:{item['episode']}".encode(
                "utf-8"
            )
        ).hexdigest()[:16]
        artifact_id = f"prep-{digest}"

        state["artifactId"] = artifact_id
        state["initialTitle"] = initial_title
        state["suggestions"] = suggestions
        state["summary"] = {"quick": quick_summary, "full": full_summary}
        state["status"] = "prepared"
        _add_checkpoint(state, state_path, "prepared", emit, "prepare")

        return {
            "recordingId": recording_id,
            "artifactId": artifact_id,
            "statePath": str(state_path),
            "status": "prepared",
            "skipped": False,
            "campaign": item["campanha"],
            "season": item["season"],
            "episode": item["episode"],
            "rssKey": item["rss_key"],
            "players": item["jogadores"],
            "initialTitle": initial_title,
            "suggestions": suggestions,
            "summary": state["summary"],
            "checkpoints": state["checkpoints"],
        }


def publish_session(
    payload: dict[str, Any],
    *,
    emit: Callable[[dict[str, Any]], None] = lambda _event: None,
    storage_adapter: Any = None,
    rss_updater_factory: Any = None,
    update_audio_tag: Callable[[Path, str], None] = _update_mp3_title_tag,
) -> dict[str, Any]:
    """Fase 2 (publish): aplica o titulo vencedor, envia artefatos, atualiza RSS e devolve anuncio."""
    recording_id = str(payload.get("recordingId") or "").strip()
    state_path_raw = str(payload.get("statePath") or "").strip()
    artifact_id = str(payload.get("artifactId") or "").strip()
    winner_title = re.sub(r"\s+", " ", str(payload.get("winnerTitle") or "")).strip()
    publish_direct = bool(payload.get("publishDirect", True))

    if not recording_id or not state_path_raw or not winner_title:
        raise WorkerError(
            "invalid_input",
            "Informe recordingId, statePath e winnerTitle para publish.",
        )

    config, storage_cfg = validate_account_payload(payload.get("account"))
    state_path = Path(state_path_raw)
    state = _read_json(state_path)
    if not isinstance(state, dict):
        raise WorkerError(
            "invalid_input",
            "Estado da fase prepare não encontrado.",
        )
    if state.get("recordingId") != recording_id:
        raise WorkerError(
            "invalid_input",
            "recordingId não corresponde ao estado preparado.",
        )
    if artifact_id and state.get("artifactId") != artifact_id:
        raise WorkerError(
            "invalid_input",
            "artifactId não corresponde ao estado preparado.",
        )

    if state.get("published") is True and state.get("winnerTitle") == winner_title:
        return {
            "recordingId": recording_id,
            "artifactId": state.get("artifactId"),
            "statePath": str(state_path),
            "status": "published",
            "published": True,
            "alreadyPublished": True,
            "winnerTitle": winner_title,
            "campaign": state["campaign"],
            "season": state.get("season"),
            "episode": state.get("episode"),
            "links": state.get("links", {}),
            "announcement": state.get("announcement", {}),
            "checkpoints": state.get("checkpoints", []),
        }

    # Persiste o titulo vencedor antes de qualquer operacao remota para sobreviver a falhas.
    state["winnerTitle"] = winner_title
    _atomic_write_json(state_path, state)

    storage = storage_adapter or AccountObjectStorage(
        storage_cfg,
        brand=str(config["publication"].get("brand") or "PIA"),
    )

    with scoped_podcast_config(config, state_path.parent):
        _emit_stage(emit, "publish", recording_id, 7)
        if state.get("renamedForTitle") != winner_title:
            _rename_artifacts_for_winner(state, winner_title, update_audio_tag=update_audio_tag)
            state["renamedForTitle"] = winner_title
            _add_checkpoint(state, state_path, "renamed", emit, "publish")

        rss_key = str(state["rssKey"])
        folder_rss = rss_key.rsplit("/", 1)[0]
        if publish_direct:
            prefix = folder_rss
        else:
            prefix = (
                f"{config['publication']['unpublished_prefix']}/"
                f"{audio_manager_mod.AudioManager.nome_seguro(state['campaign'])}"
            )

        _emit_stage(emit, "publish", recording_id, 8)
        formats = settings_mod.output_formats()
        artifacts = state.get("artifacts") or {}
        audio_path = artifacts.get("audio_path")
        if not audio_path or not Path(audio_path).is_file():
            raise WorkerError(
                "invalid_input",
                "Arquivo de áudio preparado não encontrado para publicação.",
            )

        upload_plan: list[tuple[str, str, str]] = [
            ("audio_path", audio_path, "audio/mpeg")
        ]
        for fmt, key, mime in (
            ("srt", "srt_path", "text/plain; charset=utf-8"),
            ("vtt", "vtt_path", "text/vtt; charset=utf-8"),
            ("txt", "roteiro_path", "text/plain; charset=utf-8"),
            ("resumo.json", "resumo_json_path", "application/json"),
        ):
            artifact_file = artifacts.get(key)
            if formats.get(fmt) and artifact_file and Path(artifact_file).is_file():
                upload_plan.append((key, artifact_file, mime))

        publication_links: dict[str, str] = dict(state.get("publicationLinks") or {})
        for key, file_path, content_type in upload_plan:
            dest_name = Path(file_path).name
            object_key = f"{prefix}/{dest_name}"
            storage.sendObject(file_path, object_key, content_type)
            url = storage.public_url(object_key)
            if key == "audio_path":
                publication_links["MP3"] = url
            elif key == "roteiro_path":
                publication_links["Transcrição TXT"] = url

        state["publicationLinks"] = publication_links
        _add_checkpoint(state, state_path, "uploaded", emit, "publish")

        _emit_stage(emit, "publish", recording_id, 9)
        build_updater = rss_updater_factory or rss_mod.RssTranscriptionUpdater
        rss_updater = build_updater(storage)
        rss_result = rss_updater.updateRssTranscriptionFiles(folder=folder_rss)
        if (
            not isinstance(rss_result, dict)
            or rss_result.get("success") is not True
            or not any(
                folder.get("folder") == folder_rss
                for folder in rss_result.get("folders", [])
            )
        ):
            errors = rss_result.get("errors", []) if isinstance(rss_result, dict) else []
            detail = (
                "; ".join(str(error.get("erro", error)) for error in errors)
                or "A campanha não foi atualizada."
            )
            raise WorkerError(
                "worker_error",
                "Falha ao atualizar RSS e transcrições: "
                + detail
                + " O título vencedor foi mantido para nova tentativa.",
            )

        _add_checkpoint(state, state_path, "feed_updated", emit, "publish")

        _emit_stage(emit, "publish", recording_id, 10)
        links = {
            **publication_links,
            "RSS": storage.public_url(rss_key),
            "Transcrições gerais": storage.public_url(f"{folder_rss}/transcripts.html"),
        }
        announcement = build_announcement(
            winner_title=winner_title,
            campaign=state["campaign"],
            links=links,
            season=state.get("season"),
            episode=state.get("episode"),
            players=state.get("players", []),
            discord_users=config.get("discord_users", {}),
        )

        state["links"] = links
        state["announcement"] = announcement
        state["published"] = True
        state["status"] = "published"
        state["publishedAt"] = datetime.now(timezone.utc).isoformat()
        _add_checkpoint(state, state_path, "published", emit, "publish")

        return {
            "recordingId": recording_id,
            "artifactId": state.get("artifactId"),
            "statePath": str(state_path),
            "status": "published",
            "published": True,
            "alreadyPublished": False,
            "winnerTitle": winner_title,
            "campaign": state["campaign"],
            "season": state.get("season"),
            "episode": state.get("episode"),
            "links": links,
            "announcement": announcement,
            "checkpoints": state["checkpoints"],
        }


def run_cli(stdin=None, stdout=None, stderr=None) -> int:
    in_stream = stdin or sys.stdin
    out_stream = stdout or sys.stdout
    err_stream = stderr or sys.stderr
    secrets: tuple[str, ...] = ()
    action = ""
    recording_id = ""

    def emit(event: dict[str, Any]) -> None:
        out_stream.write(json.dumps(event, ensure_ascii=False) + "\n")
        out_stream.flush()

    try:
        raw = in_stream.read()
        payload = json.loads(raw) if raw and raw.strip() else None
        if not isinstance(payload, dict):
            raise WorkerError("invalid_input", "Entrada JSON inválida no stdin.")
        secrets = _extract_secrets(payload)
        app_context = os.environ.get("PIA_APP_CONTEXT")
        if app_context:
            secrets += _extract_secrets(json.loads(app_context))
        action = str(payload.get("action") or "").strip()
        recording_id = str(payload.get("recordingId") or "").strip()

        with contextlib.redirect_stdout(err_stream):
            if action == "prepare":
                result = prepare_session(payload, emit=emit)
            elif action == "publish":
                result = publish_session(payload, emit=emit)
            else:
                raise WorkerError(
                    "invalid_input",
                    f"Ação não suportada: {action or '(vazia)'}. Use prepare ou publish.",
                )

        emit(
            {
                "event": "result",
                "ok": True,
                "action": action,
                "recordingId": recording_id,
                "result": result,
            }
        )
        return 0
    except WorkerError as exc:
        emit(
            {
                "event": "error",
                "ok": False,
                "action": action,
                "recordingId": recording_id,
                "code": exc.code,
                "message": sanitize_message(str(exc), secrets),
                **({"missingConfig": exc.missing_config} if exc.missing_config else {}),
            }
        )
        return 1
    except Exception as exc:
        emit(
            {
                "event": "error",
                "ok": False,
                "action": action,
                "recordingId": recording_id,
                "code": "worker_error",
                "message": sanitize_message(str(exc), secrets),
            }
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(run_cli())
