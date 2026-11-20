"""Cache local descartável, isolado por bucket e configuração de saída."""

import hashlib
import json
import os
from pathlib import Path
import tempfile

from .settings import project_path
from src.config_paths import BASE_DIR


# Incremente quando o formato do cache ou a renderização dos feeds mudar.
CACHE_VERSION = 2


def signature(value):
    data = json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def object_signature(obj):
    # Sem identidade de versão não é seguro reaproveitar uma leitura anterior.
    if not any(
        obj.get(key) is not None for key in ("ETag", "LastModified", "VersionId")
    ):
        return None
    return signature(
        {
            key: obj.get(key)
            for key in ("Key", "ETag", "LastModified", "Size", "VersionId")
        }
    )


def manifest(objects):
    versions = {obj["Key"]: object_signature(obj) for obj in objects}
    if any(version is None for version in versions.values()):
        return None
    return signature(versions)


class FeedCache:
    def __init__(self, scope):
        from src.settings_store import get

        root = Path(
            get("FEED_CACHE_DIR", section="Apps/podcast_automation")
            or BASE_DIR / "cache/Apps/podcast_automation/feeds"
        )
        self.path = root / (signature([CACHE_VERSION, scope]) + ".json")
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or not all(
                isinstance(data.get(k), dict) for k in ("folders", "durations")
            ):
                raise ValueError("Cache inválido")
            self.data = data
        except (OSError, ValueError):
            self.data = {"folders": {}, "durations": {}}

    def save(self):
        temporary = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=self.path.parent, delete=False
            ) as file:
                temporary = Path(file.name)
                json.dump(self.data, file, ensure_ascii=False)
            temporary.replace(self.path)
        except OSError:
            print(
                "Aviso: cache de feeds não pôde ser salvo; a reconstrução continua funcionando."
            )
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass
