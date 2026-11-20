"""Shared Drive adapter using the accounts authorized in PIA's Google connector."""

from pathlib import Path
import json
from urllib.parse import quote, urlsplit
from src.settings_store import values as section_values, document, save_document
from src.resource_plugins import get_resources
from Plugins.Connectors.pia_server.remote import managed, runtime

ROOT = Path(__file__).resolve().parent


class Drive:
    def __init__(self, resources=None, root=ROOT):
        self.resources = resources or get_resources()
        self.root = Path(root)
        self._credentials = None

    def config(self):
        if managed():
            return runtime("google")["settings"]
        return section_values("Connectors/google")

    @property
    def default_folder(self):
        return self.config().get("GOOGLE_DRIVE_FOLDER_ID", "")

    def accounts(self):
        return self.resources.accounts("google")

    def account(self, identity=None):
        accounts = self.accounts()
        identity = identity or (accounts[0]["id"] if accounts else "")
        if not any(a["id"] == identity for a in accounts):
            raise ValueError("Conecte uma conta Google nas configurações da PIA.")
        return identity

    def headers(self, identity):
        identity = self.account(identity)
        return {
            "Authorization": "Bearer "
            + self.resources._access_token("google", identity)
        }

    def request(
        self, method, path, account=None, *, upload=False, headers=None, **kwargs
    ):
        base = (
            "https://www.googleapis.com"
            + ("/upload" if upload else "")
            + "/drive/v3/files"
        )
        response = self.resources.session.request(
            method,
            base + path,
            headers={**self.headers(account), **(headers or {})},
            timeout=60,
            **kwargs,
        )
        from src.plugin_logs import write

        write(
            "Connectors/google", "Drive " + method, "HTTP " + str(response.status_code)
        )
        if response.status_code >= 400:
            response.close()
            raise RuntimeError(
                f"Google Drive retornou HTTP {response.status_code}. Verifique as permissões da conta."
            )
        return response

    @staticmethod
    def escape(value):
        return str(value).replace("\\", "\\\\").replace("'", "\\'")

    def folder_path(self, identity, account=None):
        parts = []
        seen = set()
        while identity:
            if identity in seen or len(seen) >= 100:
                raise ValueError(
                    "Não foi possível resolver a hierarquia de pastas do Drive."
                )
            seen.add(identity)
            with self.request(
                "GET",
                "/" + quote(identity, safe=""),
                account,
                params={"fields": "id,name,parents", "supportsAllDrives": True},
            ) as response:
                folder = response.json()
            parts.append(folder.get("name") or "Meu Drive")
            identity = next(iter(folder.get("parents", [])), None)
        return " / ".join(reversed(parts))

    def list(
        self, account=None, folder=None, folders_only=False, cursor=None, search=None
    ):
        query = ["trashed = false"]
        if folder:
            query.append("'" + self.escape(folder) + "' in parents")
        if folders_only:
            query.append("mimeType = 'application/vnd.google-apps.folder'")
        if search:
            query.append("name contains '" + self.escape(search) + "'")
        params = dict(
            q=" and ".join(query),
            pageSize=100,
            fields="nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,appProperties)",
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        )
        if cursor:
            params["pageToken"] = cursor
        with self.request("GET", "", account, params=params) as response:
            return response.json()

    def download(self, identity, destination, account=None):
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(destination.suffix + ".part")
        try:
            with (
                self.request(
                    "GET",
                    "/" + quote(identity, safe=""),
                    account,
                    params={"alt": "media", "supportsAllDrives": True},
                    stream=True,
                ) as response,
                temporary.open("wb") as output,
            ):
                for chunk in response.iter_content(1024 * 1024):
                    output.write(chunk)
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
        return destination

    def rename(self, identity, name, account=None):
        with self.request(
            "PATCH",
            "/" + quote(identity, safe=""),
            account,
            params={"supportsAllDrives": True},
            json={"name": name},
        ) as response:
            return response.json()

    def save_app_data(self, account, name, content):
        with self.request(
            "POST",
            "",
            account,
            upload=True,
            headers={
                "X-Upload-Content-Type": "application/octet-stream",
                "X-Upload-Content-Length": str(len(content)),
            },
            params={"uploadType": "resumable", "fields": "id,createdTime"},
            json={"name": name, "parents": ["appDataFolder"]},
            allow_redirects=False,
        ) as response:
            location = response.headers.get("Location", "")
        destination = urlsplit(location)
        if (destination.scheme, destination.netloc, destination.path) != (
            "https",
            "www.googleapis.com",
            "/upload/drive/v3/files",
        ):
            raise RuntimeError("O Google Drive não confirmou o endereço do upload.")
        with self.resources.session.request(
            "PUT",
            location,
            data=content,
            timeout=60,
            allow_redirects=False,
            headers={
                **self.headers(account),
                "Content-Type": "application/octet-stream",
            },
        ) as response:
            if response.status_code not in (200, 201):
                raise RuntimeError(
                    f"Google Drive não confirmou o backup (HTTP {response.status_code})."
                )
            return response.json()

    def latest_app_data(self, account, name, limit):
        params = {
            "spaces": "appDataFolder",
            "q": "name = '" + self.escape(name) + "'",
            "orderBy": "createdTime desc",
            "pageSize": 1,
            "fields": "nextPageToken,files(id,createdTime)",
        }
        while True:
            with self.request("GET", "", account, params=params) as response:
                listing = response.json()
            if listing.get("files"):
                file = listing["files"][0]
                break
            if not listing.get("nextPageToken"):
                raise ValueError("Nenhum backup da PIA encontrado nesta conta Google.")
            params["pageToken"] = listing["nextPageToken"]
        content = bytearray()
        with self.request(
            "GET",
            "/" + quote(file["id"], safe=""),
            account,
            params={"alt": "media"},
            stream=True,
        ) as response:
            for chunk in response.iter_content(1024 * 1024):
                if len(content) + len(chunk) > limit:
                    raise ValueError("O backup no Google Drive excede o limite da PIA.")
                content.extend(chunk)
        return file, content
