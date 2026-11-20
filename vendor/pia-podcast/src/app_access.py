from src.settings_store import get as setting

"""Per-process capabilities for apps launched by PIA. Never trust Origin alone."""
import json
import os
import secrets
import threading
from urllib.parse import urlsplit

_tokens = {}
_lock = threading.Lock()
ROUTES = {"/v1/chat/completions", "/v1/audio/transcriptions", "/v1/audio/speech"}


def issue(app, routes=None):
    from .config import PORT, LLM_MODEL, OPENAI_COMPAT_MAX_UPLOAD_BYTES

    token = secrets.token_urlsafe(48)
    with _lock:
        _tokens[token] = {
            "app": app,
            "routes": set(routes) if routes is not None else ROUTES,
        }
    return json.dumps(
        dict(
            token=token,
            app=app,
            url=f"http://localhost:{PORT}",
            model=LLM_MODEL,
            max_upload_bytes=OPENAI_COMPAT_MAX_UPLOAD_BYTES,
            stt_timeout=int(setting("STT_FILE_TIMEOUT_SECONDS") or "86400") + 30,
        )
    )


def revoke(context):
    with _lock:
        _tokens.pop(json.loads(context)["token"], None)


def authorized(handler):
    token = handler.headers.get("X-PIA-App-Token", "")
    if handler.client_address[0] not in ("127.0.0.1", "::1") or handler.headers.get(
        "Origin"
    ):
        return False
    path = urlsplit(handler.path).path
    with _lock:
        return bool(
            token
            and token in _tokens
            and (
                path in _tokens[token]["routes"]
                or (
                    path.startswith("/v1/audio/transcriptions/progress/")
                    and "/v1/audio/transcriptions" in _tokens[token]["routes"]
                )
            )
        )


def current():
    value = os.environ.get("PIA_APP_CONTEXT")
    if value:
        return json.loads(value)
    # An app run manually has no internal identity and cannot bypass API auth.
    from .config import PORT, LLM_MODEL, OPENAI_COMPAT_MAX_UPLOAD_BYTES

    return dict(
        url=f"http://localhost:{PORT}",
        model=LLM_MODEL,
        max_upload_bytes=OPENAI_COMPAT_MAX_UPLOAD_BYTES,
    )


def headers():
    context = current()
    return {"X-PIA-App-Token": context["token"]} if context.get("token") else {}
