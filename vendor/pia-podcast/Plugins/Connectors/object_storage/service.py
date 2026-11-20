"""Shared S3-compatible accounts and transfers. No podcast-specific configuration."""

from pathlib import Path
from urllib.parse import urlsplit, quote
import uuid
import threading

_CONFIG_LOCK = threading.RLock()
from src.settings_store import values as section_values, document, save_document
from src.resource_plugins import KeyringVault, save_json
from Plugins.Connectors.pia_server.remote import managed, runtime
import json
import re
import secrets


def valid_color(value):
    if not isinstance(value, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        raise ValueError("Cor de conta inválida; use #RRGGBB.")
    return value


def random_color():
    return secrets.choice(
        ("#9b7aff", "#54c7ec", "#df8ec7", "#65cfa4", "#e7af68", "#8fa8ff")
    )


ROOT = Path(__file__).resolve().parent


class ObjectStorage:
    def __init__(self, root=ROOT, vault=None, client_factory=None):
        self.root = Path(root)
        self._vault = vault
        self.client_factory = client_factory

    @property
    def vault(self):
        if self._vault is None:
            self._vault = KeyringVault()
        return self._vault

    def config(self):
        if managed():
            return runtime("object_storage")["config"]
        return document("Connectors/object_storage", {"accounts": []})

    def legacy(self):
        return None

    def accounts(self):
        with _CONFIG_LOCK:
            config = self.config()
            result = config.get("accounts", [])
            changed = False
            for account in result:
                if not account.get("color"):
                    account["color"] = "#9b7aff" if managed() else random_color()
                    changed = True
            if changed and not managed():
                save_document("Connectors/object_storage", config)
        overrides = json.loads(
            "{}"
            if managed()
            else section_values("Connectors/object_storage").get(
                "OBJECT_STORAGE_ACCOUNT_COLORS"
            )
            or "{}"
        )
        if not isinstance(overrides, dict):
            raise ValueError(
                "OBJECT_STORAGE_ACCOUNT_COLORS deve ser um objeto JSON de ID para cor."
            )
        for account in result:
            account["color"] = valid_color(
                overrides.get(account["id"], account.get("color", "#9b7aff"))
            )
        return result

    def account(self, identity=None):
        accounts = self.accounts()
        identity = (
            identity
            or self.config().get("default")
            or (accounts[0]["id"] if accounts else None)
        )
        account = next((a for a in accounts if a["id"] == identity), None)
        if account is None:
            raise ValueError("Selecione uma conta de Object Storage nas configurações.")
        return account

    def save_account(self, value):
        if managed():
            raise ValueError("Gerencie contas de Object Storage na PIA Server.")
        with _CONFIG_LOCK:
            return self._save_account(value)

    def _save_account(self, value):
        config = self.config()
        identity = value.get("id") or uuid.uuid4().hex
        endpoint = value.get("endpoint", "").strip()
        public = value.get("public_url", "").strip()
        provider = value.get("provider", "s3")
        if provider not in ("s3", "r2", "compatible") or (
            provider != "s3" and not endpoint
        ):
            raise ValueError(
                "Escolha um provedor válido e configure o endpoint S3 do serviço."
            )
        for url in (endpoint, public):
            if url and (
                urlsplit(url).scheme not in ("http", "https")
                or not urlsplit(url).hostname
                or urlsplit(url).username
            ):
                raise ValueError("URL de storage inválida.")
        if not value.get("name", "").strip():
            raise ValueError("Informe o nome da conta.")
        metadata = {
            k: str(value.get(k, "")).strip()
            for k in ("name", "provider", "region", "bucket")
        }
        metadata.update(id=identity, endpoint=endpoint, public_url=public)
        previous = next(
            (a for a in config.get("accounts", []) if a["id"] == identity), {}
        )
        metadata["color"] = valid_color(
            value.get("color") or previous.get("color") or random_color()
        )
        secret = self.vault.get("storage:" + identity) or {}
        for key in ("access_key", "secret_key", "session_token"):
            if value.get(key):
                secret[key] = value[key]
        if not secret.get("access_key") or not secret.get("secret_key"):
            raise ValueError("Informe access key e secret key.")
        self.vault.set("storage:" + identity, secret)
        config["accounts"] = [
            a for a in config.get("accounts", []) if a["id"] != identity
        ] + [metadata]
        if value.get("default") or not config.get("default"):
            config["default"] = identity
        save_document("Connectors/object_storage", config)
        return {"id": identity}

    def remove_account(self, identity):
        if managed():
            raise ValueError("Gerencie contas de Object Storage na PIA Server.")
        with _CONFIG_LOCK:
            return self._remove_account(identity)

    def _remove_account(self, identity):
        config = self.config()
        config["accounts"] = [
            a for a in config.get("accounts", []) if a["id"] != identity
        ]
        if config.get("default") == identity:
            config.pop("default", None)
        self.vault.delete("storage:" + identity)
        save_document("Connectors/object_storage", config)

    def client(self, identity=None):
        account = self.account(identity)
        secret = (
            runtime("object_storage", account["id"]).get("secret")
            if managed()
            else self.vault.get("storage:" + account["id"])
        )
        if not secret:
            raise ValueError("Credenciais não disponíveis no cofre.")
        import boto3
        from botocore.config import Config

        factory = self.client_factory or boto3.client
        return factory(
            "s3",
            endpoint_url=account["endpoint"] or None,
            region_name=(account["region"] or "us-east-1")
            if account["endpoint"]
            else (
                "us-east-1" if account["region"] in ("", "auto") else account["region"]
            ),
            aws_access_key_id=secret["access_key"],
            aws_secret_access_key=secret["secret_key"],
            aws_session_token=secret.get("session_token") or None,
            config=Config(signature_version="s3v4", s3={"addressing_style": "auto"}),
        )

    def bucket(self, identity=None, bucket=None):
        value = bucket or self.account(identity).get("bucket")
        if not value:
            raise ValueError("Selecione um bucket.")
        return value

    @staticmethod
    def key(key):
        if not isinstance(key, str) or not key or len(key.encode()) > 1024:
            raise ValueError("Chave do objeto inválida.")
        return key

    def list(self, account=None, bucket=None, prefix="", cursor=None, limit=100):
        params = dict(
            Bucket=self.bucket(account, bucket),
            Prefix=prefix,
            Delimiter="/",
            MaxKeys=max(1, min(1000, int(limit))),
        )
        if cursor:
            params["ContinuationToken"] = cursor
        page = self.client(account).list_objects_v2(**params)
        return {
            "folders": [p["Prefix"] for p in page.get("CommonPrefixes", [])],
            "objects": [
                dict(
                    key=o["Key"],
                    size=o["Size"],
                    modified=o["LastModified"].isoformat()
                    if hasattr(o.get("LastModified"), "isoformat")
                    else str(o.get("LastModified", "")),
                )
                for o in page.get("Contents", [])
                if o["Key"] != prefix
            ],
            "cursor": page.get("NextContinuationToken"),
        }

    def objects(self, account=None, bucket=None, prefix=""):
        client = self.client(account)
        params = dict(Bucket=self.bucket(account, bucket), Prefix=prefix)
        while True:
            page = client.list_objects_v2(**params)
            yield from page.get("Contents", [])
            if not page.get("IsTruncated"):
                break
            params["ContinuationToken"] = page["NextContinuationToken"]

    def get(self, key, account=None, bucket=None):
        body = self.client(account).get_object(
            Bucket=self.bucket(account, bucket), Key=self.key(key)
        )["Body"]
        try:
            return body.read()
        finally:
            body.close()

    def upload(
        self,
        path,
        key,
        account=None,
        bucket=None,
        content_type="application/octet-stream",
        metadata=None,
        callback=None,
    ):
        self.client(account).upload_file(
            str(path),
            self.bucket(account, bucket),
            self.key(key),
            ExtraArgs={"ContentType": content_type, "Metadata": metadata or {}},
            Callback=callback,
        )

    def put(
        self,
        key,
        data,
        account=None,
        bucket=None,
        content_type="application/octet-stream",
        metadata=None,
    ):
        self.client(account).put_object(
            Bucket=self.bucket(account, bucket),
            Key=self.key(key),
            Body=data,
            ContentType=content_type,
            CacheControl="max-age=300",
            Metadata=metadata or {},
        )

    def delete(self, keys, account=None, bucket=None):
        client = self.client(account)
        bucket = self.bucket(account, bucket)
        if not isinstance(keys, list) or not keys:
            raise ValueError("Selecione os objetos a excluir.")
        all_keys = []
        for key in keys:
            self.key(key)
            all_keys.extend(
                o["Key"] for o in self.objects(account, bucket, key)
            ) if key.endswith("/") else all_keys.append(key)
        for start in range(0, len(all_keys), 1000):
            result = client.delete_objects(
                Bucket=bucket,
                Delete={
                    "Objects": [{"Key": k} for k in all_keys[start : start + 1000]]
                },
            )
            if result.get("Errors"):
                raise RuntimeError(
                    "Alguns objetos não puderam ser excluídos. Atualize a lista para verificar."
                )

    def copy(
        self,
        key,
        target,
        account=None,
        bucket=None,
        target_account=None,
        target_bucket=None,
        move=False,
    ):
        self.key(key)
        self.key(target)
        target_account = target_account or account
        source = self.client(account)
        dest = self.client(target_account)
        bucket = self.bucket(account, bucket)
        target_bucket = self.bucket(target_account, target_bucket)
        if (
            self.account(account)["id"] == self.account(target_account)["id"]
            and bucket == target_bucket
            and key == target
        ):
            raise ValueError("Origem e destino são iguais.")
        if self.account(account)["id"] == self.account(target_account)["id"]:
            dest.copy({"Bucket": bucket, "Key": key}, target_bucket, target)
        else:
            response = source.get_object(Bucket=bucket, Key=key)
            try:
                dest.upload_fileobj(
                    response["Body"],
                    target_bucket,
                    target,
                    ExtraArgs={
                        "ContentType": response.get(
                            "ContentType", "application/octet-stream"
                        ),
                        "Metadata": response.get("Metadata", {}),
                    },
                )
            finally:
                response["Body"].close()
        if move:
            source.delete_object(Bucket=bucket, Key=key)

    def public_url(self, key, account=None):
        url = self.account(account).get("public_url", "")
        if not url:
            raise ValueError(
                "Configure a URL pública desta conta para publicar o podcast."
            )
        return url.rstrip("/") + "/" + quote(self.key(key), safe="/")
