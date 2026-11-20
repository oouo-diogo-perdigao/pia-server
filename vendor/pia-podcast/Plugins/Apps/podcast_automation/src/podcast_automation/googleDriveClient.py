"""Podcast adapter. Authentication, listing and downloads belong to the Google plugin."""

from pathlib import Path
from urllib.parse import quote
import json
from Plugins.Connectors.google.drive import Drive
from .settings import get_config, get_download_dir


class GoogleDriveClient:
    def __init__(self):
        self.plugin = Drive()
        self.account = self.plugin.account(
            get_config().get("integrations", {}).get("google_account")
        )

    def list_zip_files(self, folder_path):
        files = []
        cursor = None
        self.sidecars = {}
        while True:
            response = self.plugin.list(self.account, folder_path, cursor=cursor)
            for file in response.get("files", []):
                if file["name"].lower().endswith(".zip"):
                    files.append(file)
                elif file["name"].lower().endswith(".aup.json"):
                    self.sidecars[file["name"]] = file["id"]
            cursor = response.get("nextPageToken")
            if not cursor:
                break
        return files

    def recording_metadata(self, zip_name):
        name = zip_name[:-4] + ".json"
        identity = getattr(self, "sidecars", {}).get(name)
        if not identity:
            return {}
        with self.plugin.request(
            "GET",
            "/" + quote(identity, safe=""),
            self.account,
            params={"alt": "media", "supportsAllDrives": True},
            stream=True,
        ) as response:
            content = bytearray()
            for chunk in response.iter_content(4096):
                content.extend(chunk)
                if len(content) > 16384:
                    raise ValueError("Metadados de gravação excedem o limite.")
        value = json.loads(content)
        return (
            value
            if isinstance(value, dict) and value.get("source") == "pia-server-discord"
            else {}
        )

    def download_file(self, file):
        name = Path(file["name"]).name
        if name != file["name"] or name in (".", ".."):
            raise ValueError("Nome de arquivo do Drive inválido.")
        target = get_download_dir() / name
        return (
            target
            if target.exists()
            else self.plugin.download(file["id"], target, self.account)
        )

    def rename_processed(self, id, name, status="ok"):
        suffix = "-" + status
        if name.lower().endswith(suffix + ".zip"):
            return
        new = (
            name[:-4] + suffix + ".zip"
            if name.lower().endswith(".zip")
            else name + suffix
        )
        self.plugin.rename(id, new, self.account)
