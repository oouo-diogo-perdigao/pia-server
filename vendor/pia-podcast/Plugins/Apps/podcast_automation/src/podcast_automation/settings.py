"""Configuração privada; caminhos relativos à raiz e ambiente com precedência."""

import json
import os
from functools import lru_cache
from pathlib import Path
from src.settings_store import values, document
from src.user_paths import user_path

ROOT = Path(__file__).resolve().parents[2]


def option(name, default=None):
    return values("Apps/podcast_automation").get(name, default)


def project_path(value: str) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else user_path("apps/podcast_automation") / path


@lru_cache(maxsize=1)
def get_config() -> dict:
    data = document("Apps/podcast_automation/campaigns")
    if data is None:
        data = json.loads(
            (ROOT / "docs/examples/config.example.json").read_text(encoding="utf-8")
        )
    for key in (
        "nomes_reais",
        "campaign_details",
        "publication",
        "audio",
        "processing",
    ):
        if not isinstance(data.get(key), dict):
            raise ValueError(f"A configuração deve conter o objeto {key}.")
    if not data["campaign_details"]:
        raise ValueError("Configure pelo menos uma mesa em campaign_details.")
    folders = set()
    for narrator, table in data["campaign_details"].items():
        if (
            not isinstance(table, dict)
            or not table.get("Campanha")
            or not table.get("rss_key")
        ):
            raise ValueError(
                f"Mesa de {narrator}: Campanha e rss_key são obrigatórios."
            )
        if not isinstance(table.get("players"), dict) or any(
            not isinstance(player, str)
            or not isinstance(character, str)
            or not player.strip()
            or not character.strip()
            for player, character in table["players"].items()
        ):
            raise ValueError(
                f"Mesa de {narrator}: players deve mapear jogadores para personagens."
            )
        if not isinstance(table.get("closed", False), bool):
            raise ValueError(f"Mesa de {narrator}: closed deve ser true ou false.")
        key = table["rss_key"]
        if (
            not isinstance(key, str)
            or not key.endswith("/rss.xml")
            or any(part in ("", ".", "..") for part in key.split("/"))
        ):
            raise ValueError(
                f"Mesa de {narrator}: rss_key deve apontar para pasta/rss.xml, sem barras extras ou caminhos relativos."
            )
        folder = key.rsplit("/", 1)[0]
        if folder in folders:
            raise ValueError(f"Mais de uma mesa referencia a pasta {folder}.")
        folders.add(folder)
    return data


def env_bool(name: str, default: bool = False) -> bool:
    value = option(name, str(default)).strip().lower()
    if value not in ("true", "false", "1", "0"):
        raise ValueError(f"{name} deve ser true ou false.")
    return value in ("true", "1")


def get_download_dir() -> Path:
    path = user_path("apps/podcast_automation/download")
    path.mkdir(parents=True, exist_ok=True)
    return path


def output_formats():
    value = get_config().get("outputs", {})
    if not isinstance(value, dict) or any(
        not isinstance(v, bool) for v in value.values()
    ):
        raise ValueError("outputs deve conter opções booleanas.")
    return {
        **{name: True for name in ("resumo.json", "srt", "txt", "vtt")},
        **value,
        "mp3": True,
    }
