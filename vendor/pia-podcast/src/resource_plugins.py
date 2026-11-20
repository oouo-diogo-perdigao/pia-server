"""Local, multi-account OAuth connectors exposed to skills as piaPlugins.

Only fixed, read-only operations are exposed. Tokens are stored in the OS keyring,
never in manifests, account metadata, chat history or logs.
"""

from __future__ import annotations
import base64
import hashlib
import json
import secrets
import threading
import time
import tomllib
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlencode, urlsplit, parse_qs, quote

from .config_paths import BASE_DIR
from .settings_store import save_document


def save_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as out:
        json.dump(value, out, ensure_ascii=False, indent=2)
    temporary.chmod(0o600)
    temporary.replace(path)


from .core.secrets.vault import KeyringVault  # noqa: E402, F401


class ResourcePlugins:
    def __init__(self, root=None, vault=None, session=None):
        self.root = Path(root or BASE_DIR / "Plugins" / "Connectors")
        self._vault = vault
        self._session = session
        self.lock = threading.RLock()

    @property
    def vault(self):
        if self._vault is None:
            self._vault = KeyringVault()
        return self._vault

    @property
    def session(self):
        if self._session is None:
            import requests

            self._session = requests.Session()
        return self._session

    def manifests(self):
        result = []
        for path in sorted(self.root.glob("*/plugin.toml")):
            data = tomllib.loads(path.read_text(encoding="utf-8"))
            meta = path.parent / "pia.json"
            if meta.exists():
                manifest = json.loads(meta.read_text(encoding="utf-8"))
                data.update(name=manifest["nome"], description=manifest.get("info", ""))
            if data.get("id") != path.parent.name or data.get("provider") not in (
                "google",
                "microsoft",
            ):
                continue
            result.append(data)
        return result

    def manifest(self, plugin):
        return next(p for p in self.manifests() if p["id"] == plugin)

    def config(self, plugin):
        self.manifest(plugin)
        from Plugins.Connectors.pia_server.remote import managed, runtime

        if managed():
            return runtime(plugin)["config"]
        from .settings_store import document

        return document("Connectors/" + plugin, {})

    def configure(self, plugin, client_id, client_secret=None):
        from Plugins.Connectors.pia_server.remote import managed

        if managed():
            raise ValueError("Gerencie o cliente OAuth no painel da PIA Server.")
        with self.lock:
            data = self.config(plugin)
            data["client_id"] = client_id.strip()
            if client_secret:
                self.vault.set("client:" + plugin, client_secret)
            save_document("Connectors/" + plugin, data)

    def accounts(self, plugin=None):
        with self.lock:
            result = []
            for manifest in self.manifests():
                if plugin and plugin != manifest["id"]:
                    continue
                for account in self.config(manifest["id"]).get("accounts", []):
                    result.append({**account, "plugin": manifest["id"]})
            return result

    def disconnect(self, plugin, account):
        from Plugins.Connectors.pia_server.remote import managed

        if managed():
            raise ValueError("Remova a conta no painel da PIA Server.")
        with self.lock:
            data = self.config(plugin)
            data["accounts"] = [
                a for a in data.get("accounts", []) if a["id"] != account
            ]
            self.vault.delete("token:" + plugin + ":" + account)
            save_document("Connectors/" + plugin, data)

    def _endpoints(self, plugin):
        provider = self.manifest(plugin)["provider"]
        if provider == "google":
            return (
                "https://accounts.google.com/o/oauth2/v2/auth",
                "https://oauth2.googleapis.com/token",
            )
        return (
            "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        )

    def _token_request(self, plugin, payload):
        response = self.session.post(
            self._endpoints(plugin)[1], data=payload, timeout=30
        )
        if response.status_code >= 400:
            # Never include token response bodies (or authorization codes) in errors/logs.
            raise RuntimeError(
                "OAuth falhou. Verifique o cadastro do aplicativo e reconecte a conta."
            )
        data = response.json()
        if not data.get("access_token"):
            raise RuntimeError("OAuth não retornou um token de acesso.")
        return {
            **{
                key: data[key]
                for key in ("access_token", "refresh_token", "scope", "token_type")
                if key in data
            },
            "expires_at": time.time() + int(data.get("expires_in", 3600)),
        }

    def connect(self, plugin, label):
        """Interactive installed-app PKCE flow. Call from a worker, never the Qt thread."""
        from Plugins.Connectors.pia_server.remote import managed

        if managed():
            raise ValueError("Adicione a conta no painel da PIA Server.")
        manifest, config = self.manifest(plugin), self.config(plugin)
        client_id = config.get("client_id", "")
        if not client_id:
            raise ValueError("Informe o Client ID do aplicativo antes de conectar.")
        # Check availability before opening the browser.
        self.vault.get("client:" + plugin)
        verifier, state = secrets.token_urlsafe(48), secrets.token_urlsafe(32)
        challenge = (
            base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
            .rstrip(b"=")
            .decode()
        )
        received = {}

        class Callback(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                url = urlsplit(self.path)
                params = parse_qs(url.query)
                valid = url.path == "/callback" and secrets.compare_digest(
                    params.get("state", [""])[0], state
                )
                if valid:
                    received.update(
                        code=params.get("code", [""])[0],
                        error=params.get("error", [""])[0],
                    )
                self.send_response(200 if valid else 400)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write(
                    "Autorização recebida. Pode voltar à PIA.".encode("utf-8")
                    if valid
                    else b"Invalid OAuth state."
                )

        with HTTPServer(("127.0.0.1", 0), Callback) as server:
            host = "127.0.0.1" if manifest["provider"] == "google" else "localhost"
            redirect = f"http://{host}:{server.server_port}/callback"
            params = dict(
                client_id=client_id,
                redirect_uri=redirect,
                response_type="code",
                scope=" ".join(manifest["scopes"]),
                state=state,
                code_challenge=challenge,
                code_challenge_method="S256",
            )
            if manifest["provider"] == "google":
                params.update(access_type="offline", prompt="consent select_account")
            else:
                params.update(prompt="select_account")
            server.timeout = 1
            if not webbrowser.open(
                self._endpoints(plugin)[0] + "?" + urlencode(params)
            ):
                raise RuntimeError(
                    "Não foi possível abrir o navegador para autorizar a conta."
                )
            deadline = time.monotonic() + 180
            while not received and time.monotonic() < deadline:
                server.handle_request()
        if not received.get("code"):
            raise RuntimeError(
                "Autorização cancelada ou expirada. Tente conectar novamente."
            )
        payload = dict(
            grant_type="authorization_code",
            code=received["code"],
            client_id=client_id,
            redirect_uri=redirect,
            code_verifier=verifier,
        )
        secret = self.vault.get("client:" + plugin)
        if secret and manifest["provider"] == "google":
            payload["client_secret"] = secret
        token = self._token_request(plugin, payload)
        profile_url = (
            "https://www.googleapis.com/oauth2/v2/userinfo"
            if manifest["provider"] == "google"
            else "https://graph.microsoft.com/v1.0/me"
        )
        profile = self.session.get(
            profile_url,
            headers={"Authorization": "Bearer " + token["access_token"]},
            timeout=30,
        )
        profile.raise_for_status()
        data = profile.json()
        identity = str(data.get("id") or "")
        if not identity:
            raise RuntimeError("Não foi possível identificar a conta autorizada.")
        with self.lock:
            config = self.config(plugin)
            account_id = hashlib.sha256((plugin + ":" + identity).encode()).hexdigest()[
                :24
            ]
            self.vault.set("token:" + plugin + ":" + account_id, token)
            accounts = [a for a in config.get("accounts", []) if a["id"] != account_id]
            accounts.append(
                {
                    "id": account_id,
                    "label": label.strip() or "Minha conta",
                    "email": data.get("email")
                    or data.get("mail")
                    or data.get("userPrincipalName", ""),
                }
            )
            config["accounts"] = accounts
            save_document("Connectors/" + plugin, config)
        return account_id

    def _access_token(self, plugin, account):
        from Plugins.Connectors.pia_server.remote import managed, request

        if managed():
            return request("access", plugin, account)["token"]
        with self.lock:
            if not any(a["id"] == account for a in self.accounts(plugin)):
                raise ValueError("Conta não conectada ao plugin selecionado.")
            name = "token:" + plugin + ":" + account
            token = self.vault.get(name)
            if not token:
                raise RuntimeError(
                    "Credenciais indisponíveis no cofre. Reconecte a conta."
                )
            if token.get("expires_at", 0) <= time.time() + 60:
                config = self.config(plugin)
                payload = dict(
                    grant_type="refresh_token",
                    refresh_token=token.get("refresh_token", ""),
                    client_id=config["client_id"],
                )
                secret = self.vault.get("client:" + plugin)
                if secret and self.manifest(plugin)["provider"] == "google":
                    payload["client_secret"] = secret
                fresh = self._token_request(plugin, payload)
                token = {**token, **fresh}
                self.vault.set(name, token)
            return token["access_token"]

    def _get(self, plugin, account, url, params=None):
        response = self.session.get(
            url,
            params=params,
            headers={"Authorization": "Bearer " + self._access_token(plugin, account)},
            timeout=30,
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Falha na integração {plugin} (HTTP {response.status_code}). Reconecte a conta se necessário."
            )
        return response.json()

    def call(self, plugin, operation, *, account=None, **params):
        from src.plugin_logs import write

        try:
            result = self._call(plugin, operation, account=account, **params)
        except Exception as exc:
            write("Connectors/" + plugin, operation, type(exc).__name__)
            raise
        write("Connectors/" + plugin, operation)
        return result

    def _call(self, plugin, operation, *, account=None, **params):
        """No default account: a skill must explicitly select personal/work identity."""
        if plugin == "object_storage":
            from Plugins.Connectors.object_storage.service import ObjectStorage

            storage = ObjectStorage(vault=self.vault)
            if operation == "accounts.list":
                return storage.accounts()
            if not account:
                raise ValueError("Selecione explicitamente uma conta de storage.")
            if operation == "files.list":
                return storage.list(account=account, **params)
            raise ValueError("Operação indisponível: " + operation)
        if plugin == "discord":
            from Plugins.Connectors.discord.service import Discord

            if operation == "status":
                return Discord().public()
            if operation == "message.send":
                return Discord().send(**params)
            raise ValueError("Operação indisponível: " + operation)
        if plugin == "google" and operation == "drive.folders":
            from Plugins.Connectors.google.drive import Drive

            if not account:
                raise ValueError("Selecione explicitamente uma conta Google.")
            return Drive(self).list(account=account, folders_only=True, **params)
        provider = self.manifest(plugin)["provider"]
        if operation == "accounts.list":
            return self.accounts(plugin)
        if not account:
            raise ValueError(
                "Selecione explicitamente uma conta para acessar seus recursos."
            )
        if operation == "files.read":
            identity = params.pop("file_id", "")
            limit = min(10 * 1024 * 1024, int(params.pop("max_bytes", 1024 * 1024)))
            if not identity or params or limit <= 0:
                raise ValueError(
                    "files.read exige file_id e um limite válido (até 10 MiB)."
                )
            metadata = self.call(plugin, "files.get", account=account, file_id=identity)
            if provider == "google":
                base = "https://www.googleapis.com/drive/v3/files/" + quote(
                    identity, safe=""
                )
                if metadata.get("mimeType") == "application/vnd.google-apps.document":
                    url, query = base + "/export", {"mimeType": "text/plain"}
                else:
                    url, query = base, {"alt": "media"}
            else:
                url = (
                    "https://graph.microsoft.com/v1.0/me/drive/items/"
                    + quote(identity, safe="")
                    + "/content"
                )
                query = {}
            with self.session.get(
                url,
                params=query,
                headers={
                    "Authorization": "Bearer " + self._access_token(plugin, account)
                },
                timeout=30,
                stream=True,
            ) as response:
                if response.status_code >= 400:
                    raise RuntimeError(
                        f"Falha ao ler arquivo (HTTP {response.status_code})."
                    )
                content = bytearray()
                for chunk in response.iter_content(chunk_size=65536):
                    content.extend(chunk)
                    if len(content) > limit:
                        raise ValueError(
                            "Arquivo excede o limite de leitura configurado."
                        )
                return {
                    "mime_type": response.headers.get(
                        "Content-Type", "application/octet-stream"
                    ),
                    "data_base64": base64.b64encode(content).decode(),
                }
        identifiers = {}
        if operation == "mail.get":
            identifiers["message"] = quote(str(params.pop("id", "")), safe="")
            if not identifiers["message"]:
                raise ValueError("mail.get exige id.")
        if operation == "files.get":
            identifiers["file"] = quote(str(params.pop("file_id", "")), safe="")
            if not identifiers["file"]:
                raise ValueError("files.get exige file_id.")
        if operation == "calendar.list":
            identifiers["calendar"] = quote(
                str(params.pop("calendar", "primary")), safe=""
            )
        if provider == "google":
            routes = {
                "mail.list": (
                    "https://gmail.googleapis.com/gmail/v1/users/me/messages",
                    {"q", "pageToken", "maxResults", "labelIds"},
                ),
                "mail.get": (
                    "https://gmail.googleapis.com/gmail/v1/users/me/messages/"
                    + identifiers.get("message", ""),
                    {"format", "metadataHeaders"},
                ),
                "calendar.list": (
                    "https://www.googleapis.com/calendar/v3/calendars/"
                    + identifiers.get("calendar", "primary")
                    + "/events",
                    {
                        "timeMin",
                        "timeMax",
                        "singleEvents",
                        "orderBy",
                        "pageToken",
                        "maxResults",
                    },
                ),
                "files.list": (
                    "https://www.googleapis.com/drive/v3/files",
                    {"q", "fields", "pageToken", "pageSize"},
                ),
                "files.get": (
                    "https://www.googleapis.com/drive/v3/files/"
                    + identifiers.get("file", ""),
                    {"fields"},
                ),
            }
        else:
            routes = {
                "mail.list": (
                    "https://graph.microsoft.com/v1.0/me/messages",
                    {"$filter", "$select", "$top", "$skip", "$orderby"},
                ),
                "mail.get": (
                    "https://graph.microsoft.com/v1.0/me/messages/"
                    + identifiers.get("message", ""),
                    {"$select"},
                ),
                "calendar.list": (
                    "https://graph.microsoft.com/v1.0/me/calendarView",
                    {"startDateTime", "endDateTime", "$top", "$skip"},
                ),
                "files.list": (
                    "https://graph.microsoft.com/v1.0/me/drive/root/children",
                    {"$select", "$top", "$skip"},
                ),
                "files.get": (
                    "https://graph.microsoft.com/v1.0/me/drive/items/"
                    + identifiers.get("file", ""),
                    {"$select"},
                ),
            }
        if operation not in routes:
            raise ValueError("Operação indisponível: " + operation)
        url, allowed = routes[operation]
        if set(params) - allowed:
            raise ValueError("Parâmetros não permitidos para " + operation)
        return self._get(plugin, account, url, params)


_resources = None


def get_resources():
    global _resources
    if _resources is None:
        _resources = ResourcePlugins()
    return _resources
