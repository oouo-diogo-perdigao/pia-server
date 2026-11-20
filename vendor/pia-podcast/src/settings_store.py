"""Single settings/document service. Secrets are references, never SQLite values.

Reads don't create a profile or import old files. Migration is an explicit startup step.
Environment variables are not a source of PIA settings.
"""

import json
import re
import sqlite3
import threading
import hashlib
import secrets
from pathlib import Path
from contextlib import contextmanager, closing
from functools import wraps
from .user_paths import user_path

ROOT = Path(__file__).resolve().parents[1]
_lock = threading.RLock()
_store = None


def synchronized(function):
    @wraps(function)
    def locked(*args, **kwargs):
        with _lock:
            return function(*args, **kwargs)

    return locked


def schema(section):
    if section != "general" and not re.fullmatch(
        r"(Apps|Bot|Connectors|Skills|Browser)/[a-zA-Z0-9_-]+", section
    ):
        return []
    file = (
        ROOT / "config/settings.schema.json"
        if section == "general"
        else ROOT / "Plugins" / section / "settings.schema.json"
    )
    return json.loads(file.read_text(encoding="utf-8")) if file.is_file() else []


def sensitive(name, kind="string"):
    if kind == "secret":
        return True
    if kind in ("bool", "int", "float"):
        return False
    return (
        name == "KEY"
        or (name.endswith("_KEY") and not name.endswith("_PUBLIC_KEY"))
        or bool(
            re.search(
                r"(?:^|_)(?:API_KEY|ACCESS_KEY(?:_ID)?|SECRET|PASSWORD|TOKEN|CREDENTIALS?|PRIVATE_KEY)(?:_|$)",
                name,
            )
        )
    )


class SystemVault:
    def __init__(self):
        import keyring

        backend = keyring.get_keyring()
        if "chainer" in type(backend).__name__.lower():
            candidates = [
                candidate
                for candidate in backend.backends
                if candidate.priority > 0
                and not any(
                    word
                    in (
                        type(candidate).__module__ + "." + type(candidate).__name__
                    ).lower()
                    for word in ("plaintext", "keyrings.alt", "chainer", "fail", "null")
                )
            ]
            if candidates:
                backend = candidates[0]
        identity = (type(backend).__module__ + "." + type(backend).__name__).lower()
        if backend.priority <= 0 or any(
            word in identity
            for word in ("plaintext", "chainer", "keyrings.alt", "fail", "null")
        ):
            raise RuntimeError(
                "Cofre indisponível. Habilite o Gerenciador de Credenciais do Windows ou Secret Service no Linux."
            )
        self.keyring = backend

    @synchronized
    def get(self, name):
        value = self.keyring.get_password("PIA", name)
        if value is None:
            return None
        metadata = json.loads(value)
        if isinstance(metadata, dict) and "$pia_chunks" in metadata:
            count = metadata.get("count")
            if type(count) is not int or not 1 <= count <= 9000:
                raise RuntimeError("Entrada do cofre inválida.")
            parts = [
                self.keyring.get_password(
                    "PIA", f"{name}:chunk:{metadata['$pia_chunks']}:{index}"
                )
                for index in range(count)
            ]
            if any(part is None for part in parts):
                raise RuntimeError(
                    "Credencial incompleta no cofre. Restaure o backup ou configure novamente."
                )
            value = "".join(parts)
            if hashlib.sha256(value.encode()).hexdigest() != metadata.get("sha256"):
                raise RuntimeError("Credencial corrompida no cofre.")
        return json.loads(value)

    @synchronized
    def set(self, name, value):
        raw = json.dumps(value, ensure_ascii=True)
        if len(raw) > 8 * 1024**2:
            raise ValueError("Entrada de cofre excede 8 MiB.")
        # Generic Credentials on Windows has a small per-entry blob limit.
        # Logical entries remain portable; every chunk stays inside the OS vault.
        old = self.keyring.get_password("PIA", name)
        written = []
        metadata = None
        try:
            if len(raw) <= 1000:
                representation = raw
            else:
                generation = secrets.token_hex(16)
                parts = [
                    raw[index : index + 1000] for index in range(0, len(raw), 1000)
                ]
                for index, part in enumerate(parts):
                    child = f"{name}:chunk:{generation}:{index}"
                    self.keyring.set_password("PIA", child, part)
                    written.append(child)
                    if self.keyring.get_password("PIA", child) != part:
                        raise RuntimeError("O cofre não confirmou a credencial.")
                metadata = {
                    "$pia_chunks": generation,
                    "count": len(parts),
                    "sha256": hashlib.sha256(raw.encode()).hexdigest(),
                }
                representation = json.dumps(metadata)
            self.keyring.set_password("PIA", name, representation)
            if self.get(name) != value:
                raise RuntimeError("O cofre não confirmou a credencial.")
        except Exception:
            if old is None:
                if self.keyring.get_password("PIA", name) is not None:
                    self.keyring.delete_password("PIA", name)
            else:
                self.keyring.set_password("PIA", name, old)
            for child in written:
                try:
                    self.keyring.delete_password("PIA", child)
                except Exception:
                    pass
            raise
        if old:
            previous = json.loads(old)
            if isinstance(previous, dict) and "$pia_chunks" in previous:
                for index in range(previous["count"]):
                    try:
                        self.keyring.delete_password(
                            "PIA", f"{name}:chunk:{previous['$pia_chunks']}:{index}"
                        )
                    except Exception:
                        pass  # An orphan remains encrypted in the OS vault.

    @synchronized
    def delete(self, name):
        raw = self.keyring.get_password("PIA", name)
        if raw is None:
            return
        metadata = json.loads(raw)
        self.keyring.delete_password("PIA", name)
        if isinstance(metadata, dict) and "$pia_chunks" in metadata:
            for index in range(metadata["count"]):
                try:
                    self.keyring.delete_password(
                        "PIA", f"{name}:chunk:{metadata['$pia_chunks']}:{index}"
                    )
                except Exception:
                    pass


class SettingsStore:
    def __init__(self, path=None, vault=None):
        self.path = Path(path or user_path("workspace.sqlite3")).resolve()
        self._vault = vault

    @property
    def vault(self):
        if self._vault is None:
            self._vault = SystemVault()
        return self._vault

    @contextmanager
    def connection(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with _lock:
            db = sqlite3.connect(self.path, timeout=30)
            db.executescript("""CREATE TABLE IF NOT EXISTS settings(section TEXT,name TEXT,value TEXT,kind TEXT,secret_ref TEXT,PRIMARY KEY(section,name));
                CREATE TABLE IF NOT EXISTS documents(name TEXT PRIMARY KEY,value TEXT);
                CREATE TABLE IF NOT EXISTS vault_entries(name TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS profile_meta(name TEXT PRIMARY KEY,value TEXT);""")
            try:
                with db:
                    yield db
            finally:
                db.close()

    def rows(self, table):
        if table not in ("settings", "documents", "vault_entries", "profile_meta"):
            raise ValueError("Tabela inválida.")
        if not self.path.exists():
            return []
        with closing(
            sqlite3.connect(f"{self.path.as_uri()}?mode=ro", uri=True, timeout=30)
        ) as db:
            if not db.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
            ).fetchone():
                return []
            return db.execute("SELECT * FROM " + table).fetchall()

    @synchronized
    def values(self, section):
        values = {
            item["name"]: str(item.get("default", "")) for item in schema(section)
        }
        for group, name, value, kind, ref in self.rows("settings"):
            if group == section:
                raw = self.vault.get(ref) if ref else json.loads(value)
                if ref and raw is None:
                    raise RuntimeError(
                        "Credencial indisponível no cofre. Restaure o backup ou configure novamente: "
                        + name
                    )
                values[name] = (
                    "cofre://" + raw["filename"]
                    if kind == "file" and isinstance(raw, dict) and "filename" in raw
                    else str(raw or "")
                )
        return values

    def save(self, section, values, kinds=None, overwrite=True):
        if not isinstance(values, dict):
            raise ValueError("Configurações inválidas.")
        from .env_types import validate, split_key

        definitions = {
            row[1]: {"type": row[3]}
            for row in self.rows("settings")
            if row[0] == section
        }
        definitions.update({item["name"]: item for item in schema(section)})
        entries = []
        for raw, value in values.items():
            name, typed = split_key(raw)
            if not isinstance(name, str) or not re.fullmatch(
                r"[A-Za-z][A-Za-z0-9_]*", name
            ):
                raise ValueError("Nome de configuração inválido.")
            kind = (kinds or {}).get(name) or definitions.get(name, {}).get(
                "type", typed
            )
            if kind not in ("bool", "int", "float", "path", "file", "secret", "string"):
                raise ValueError("Tipo de configuração inválido.")
            secret = sensitive(name, kind)
            if kind == "file" and secret and str(value).startswith("cofre://"):
                old = self.vault.get("setting:" + section + ":" + name)
                if isinstance(old, dict) and str(value) == "cofre://" + old.get(
                    "filename", ""
                ):
                    continue
                raise ValueError("Arquivo do cofre inválido.")
            validate(name + "__" + kind, str(value))
            stored = str(value)
            if kind == "file" and secret and value:
                import base64

                path = Path(value)
                if path.stat().st_size > 5 * 1024**2:
                    raise ValueError("Arquivo de credenciais excede 5 MiB.")
                stored = {
                    "filename": path.name,
                    "data": base64.b64encode(path.read_bytes()).decode(),
                }
            entries.append((name, stored, kind, secret))
        existing = {(r[0], r[1]) for r in self.rows("settings")}
        undo = []
        with _lock:
            try:
                with self.connection() as db:
                    for name, value, kind, secret in entries:
                        if not overwrite and (section, name) in existing:
                            continue
                        ref = "setting:" + section + ":" + name if secret else None
                        if ref:
                            old = self.vault.get(ref)
                            undo.append((ref, old))
                            self.vault.set(ref, value)
                            if self.vault.get(ref) != value:
                                raise RuntimeError("O cofre não confirmou a gravação.")
                            db.execute(
                                "INSERT OR IGNORE INTO vault_entries VALUES(?)", (ref,)
                            )
                        db.execute(
                            "INSERT OR REPLACE INTO settings VALUES(?,?,?,?,?)",
                            (
                                section,
                                name,
                                None if ref else json.dumps(value),
                                kind,
                                ref,
                            ),
                        )
            except Exception:
                for ref, old in reversed(undo):
                    if old is None:
                        self.vault.delete(ref)
                    else:
                        self.vault.set(ref, old)
                raise

    @synchronized
    def document(self, name, default=None):
        row = next((r for r in self.rows("documents") if r[0] == name), None)
        return json.loads(row[1]) if row else default

    def set_document(self, name, value):
        with self.connection() as db:
            db.execute(
                "INSERT OR REPLACE INTO documents VALUES(?,?)",
                (name, json.dumps(value)),
            )

    def register_secret(self, name):
        with self.connection() as db:
            db.execute("INSERT OR IGNORE INTO vault_entries VALUES(?)", (name,))

    def save_file(self, section, name, filename, content):
        import base64

        if not isinstance(content, bytes) or len(content) > 5 * 1024**2:
            raise ValueError("Arquivo de credenciais inválido ou maior que 5 MiB.")
        ref = "setting:" + section + ":" + name
        value = {
            "filename": filename.replace("\\", "/").rsplit("/", 1)[-1][:180],
            "data": base64.b64encode(content).decode(),
        }
        old = self.vault.get(ref)
        try:
            with self.connection() as db:
                self.vault.set(ref, value)
                if self.vault.get(ref) != value:
                    raise RuntimeError("O cofre não confirmou o arquivo.")
                db.execute("INSERT OR IGNORE INTO vault_entries VALUES(?)", (ref,))
                db.execute(
                    "INSERT OR REPLACE INTO settings VALUES(?,?,?,?,?)",
                    (section, name, None, "file", ref),
                )
        except Exception:
            if old is None:
                self.vault.delete(ref)
            else:
                self.vault.set(ref, old)
            raise


def get_store():
    global _store
    if _store is None:
        _store = SettingsStore()
    return _store


def values(section="general"):
    return get_store().values(section)


@synchronized
def get(name, default=None, section="general"):
    store = get_store()
    for group, key, value, kind, ref in store.rows("settings"):
        if group == section and key == name:
            raw = store.vault.get(ref) if ref else json.loads(value)
            if ref and raw is None:
                raise RuntimeError(
                    "Credencial indisponível no cofre. Restaure o backup ou configure novamente: "
                    + name
                )
            return (
                "cofre://" + raw["filename"]
                if kind == "file" and isinstance(raw, dict)
                else raw
            )
    return next(
        (item.get("default", "") for item in schema(section) if item["name"] == name),
        default,
    )


def section_for(folder):
    path = Path(folder).resolve()
    if path == ROOT / "config":
        return "general"
    try:
        return path.relative_to(ROOT / "Plugins").as_posix()
    except ValueError:
        raise ValueError("Seção de configuração fora do registro de plugins.") from None


def document(name, default=None):
    return get_store().document(name, default)


def save_document(name, value):
    return get_store().set_document(name, value)


def credential_file(section, name):
    """Credential-file consumers use bytes, not a persistent plaintext filename."""
    import base64

    value = get_store().vault.get("setting:" + section + ":" + name)
    if not isinstance(value, dict) or "data" not in value:
        raise ValueError("Arquivo de credenciais não configurado.")
    return base64.b64decode(value["data"], validate=True)
