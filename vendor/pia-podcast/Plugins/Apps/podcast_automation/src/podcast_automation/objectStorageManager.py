"""Podcast-specific names/metadata over the shared Object Storage plugin."""

from botocore.exceptions import ClientError
from Plugins.Connectors.object_storage.service import ObjectStorage
from .settings import get_config


class ObjectStorageManager:
    def __init__(self):
        self.plugin = ObjectStorage()
        options = get_config().get("integrations", {})
        self.account = options.get("storage_account")
        metadata = self.plugin.account(self.account)
        self.bucket = self.plugin.bucket(self.account, options.get("storage_bucket"))
        self.identity = {
            "endpoint": metadata["endpoint"],
            "bucket": self.bucket,
            "url": metadata["public_url"],
            "account": metadata["id"],
        }

    def metadata(self):
        return {
            "uploaded_by": get_config()["publication"]["brand"],
            "source": "PIA Podcast Automation",
        }

    def getObject(self, key):
        return self.plugin.get(key, self.account, self.bucket)

    def getObjectIfExists(self, key):
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

    def sendObject(self, path, key, content_type="application/octet-stream"):
        self.plugin.upload(
            path,
            key,
            self.account,
            self.bucket,
            content_type=content_type,
            metadata=self.metadata(),
        )

    def list_objects(self, prefix):
        return list(self.plugin.objects(self.account, self.bucket, prefix))

    def putObject(self, key, data, content_type="application/octet-stream"):
        self.plugin.put(
            key,
            data,
            self.account,
            self.bucket,
            content_type=content_type,
            metadata=self.metadata(),
        )

    def public_url(self, key):
        return self.plugin.public_url(key, self.account)
