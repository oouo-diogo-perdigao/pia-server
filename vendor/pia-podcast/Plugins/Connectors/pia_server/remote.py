"""Read the central connector registry from a paired device."""

from copy import deepcopy
from hashlib import sha256
import re
import threading
from time import monotonic
from urllib.parse import urlsplit

import requests

from src.settings_store import values

SECTION = "Connectors/pia_server"
TOKEN_FIELD = "PIA_SERVER_DEVICE_TOKEN"


class DeviceUnauthorized(ValueError):
    pass


PROVIDERS = frozenset(("google", "microsoft", "object_storage", "discord", "taverns"))
SECTIONS = frozenset("Connectors/" + name for name in PROVIDERS)
_lock = threading.Lock()
_cache = {}


def managed():
    return bool(values(SECTION).get(TOKEN_FIELD))


def managed_secret(name):
    return (
        name == "client:google"
        or name == "client:microsoft"
        or name.startswith(("token:google:", "token:microsoft:", "storage:"))
        or any(
            name.startswith((f"setting:{section}:", f"file:{section}:"))
            for section in SECTIONS
        )
    )


def server_base(value):
    url = urlsplit(value)
    if (
        url.scheme != "https"
        or not url.hostname
        or url.username
        or url.password
        or url.query
        or url.fragment
        or url.path not in ("", "/")
    ):
        raise ValueError("Informe a URL HTTPS da PIA Server.")
    return f"https://{url.netloc}"


def server_request(method, path, payload=None):
    config = values(SECTION)
    base = server_base(config.get("PIA_SERVER_URL", ""))
    token = config.get(TOKEN_FIELD, "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
        raise DeviceUnauthorized("Entre na PIA Server para conectar este computador.")
    try:
        response = requests.request(
            method,
            f"{base}/device/{path}",
            json=payload,
            headers={
                "Authorization": "Bearer " + token,
                "X-PIA-Protocol": "1",
            },
            allow_redirects=False,
            timeout=15,
        )
        if response.status_code == 401:
            raise DeviceUnauthorized(
                "Este computador precisa entrar novamente na PIA Server."
            )
        if response.status_code != 200:
            result = response.json()
            raise ValueError(
                result.get("error") or "A PIA Server recusou o acesso ao conector."
            )
        return response.json()
    except requests.RequestException:
        raise ValueError(
            "Não foi possível consultar os conectores na PIA Server."
        ) from None


def account_profile():
    server = values(SECTION).get("PIA_SERVER_URL", "")
    if not managed():
        return {"authenticated": False, "server": server}
    try:
        return {
            **server_request("GET", "account"),
            "authenticated": True,
            "server": server,
        }
    except DeviceUnauthorized:
        return {"authenticated": False, "server": server}
    except ValueError:
        return {"authenticated": True, "server": server, "offline": True}


def request(path, provider, identity=None):
    return server_request(
        "POST", "connectors/" + path, {"provider": provider, "id": identity}
    )


def runtime(provider, identity=None):
    # Cache is process-local and bounded. Provider credentials are never written here.
    config = values(SECTION)
    token = sha256(config.get(TOKEN_FIELD, "").encode()).digest()
    key = (config.get("PIA_SERVER_URL"), token, provider, identity)
    with _lock:
        now = monotonic()
        for cached_key, (expires, _) in list(_cache.items()):
            if expires <= now:
                del _cache[cached_key]
        cached = _cache.get(key)
        if cached:
            return deepcopy(cached[1])
    result = request("runtime", provider, identity)
    with _lock:
        if len(_cache) >= 100:
            _cache.clear()
        _cache[key] = (monotonic() + 5, deepcopy(result))
    return result


# --- Typed device API (music/Suno, T6) ---------------------------------------
# ``server_request`` above stays as is for the connector registry. The music
# provider needs stable ``code``s, 202/410 answers and streamed downloads.
_ERROR_CODE = re.compile(r"[a-z0-9_]{1,64}")
# Private test hook: allows http:// ONLY for loopback hosts (fake pia-server).
# Never read from env/settings; tests flip it with monkeypatch.
_ALLOW_LOOPBACK_HTTP = False
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})
DEVICE_TIMEOUT = 15
UNPAIRED_MESSAGE = (
    "Para usar o Suno, entre na PIA Server em Configurações → PIA Server."
)
UNREACHABLE_MESSAGE = (
    "Não foi possível falar com a PIA Server agora. O Suno volta a aparecer "
    "quando a conexão voltar."
)


class DeviceApiError(ValueError):
    """Device API failure with a stable ``code`` and the HTTP ``status``.

    401 (device token refused, ``{error}`` without code in the repo pattern)
    is ALWAYS ``pia_server_unpaired``; a network failure or 5xx is
    ``pia_server_unreachable``. The message never carries a token or URL.
    """

    def __init__(self, code, message, status=None, details=None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.details = dict(details or {})


def device_base():
    config = values(SECTION)
    token = config.get(TOKEN_FIELD, "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token or ""):
        raise DeviceApiError("pia_server_unpaired", UNPAIRED_MESSAGE)
    raw = str(config.get("PIA_SERVER_URL", "") or "")
    url = urlsplit(raw)
    if (
        _ALLOW_LOOPBACK_HTTP is True
        and url.scheme == "http"
        and (url.hostname or "") in _LOOPBACK_HOSTS
    ):
        return f"http://{url.netloc}", token
    try:
        return server_base(raw), token
    except ValueError:
        raise DeviceApiError("pia_server_unpaired", UNPAIRED_MESSAGE) from None


def device_paired():
    try:
        device_base()
        return True
    except DeviceApiError:
        return False


def _device_error(response):
    status = response.status_code
    if status == 401:
        return DeviceApiError("pia_server_unpaired", UNPAIRED_MESSAGE, status)
    if status >= 500:
        return DeviceApiError("pia_server_unreachable", UNREACHABLE_MESSAGE, status)
    try:
        body = response.json()
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}
    code = body.get("code")
    if not (isinstance(code, str) and _ERROR_CODE.fullmatch(code)):
        code = "pia_server_error"
    message = body.get("error")
    if not isinstance(message, str) or not message.strip():
        message = "A PIA Server recusou o pedido."
    return DeviceApiError(code, message[:500], status)


def device_call(method, path, payload=None, *, stream=False, timeout=None):
    """Call ``/device/<path>``. Returns the decoded JSON (2xx) or, with
    ``stream=True``, the open 200 ``requests.Response`` (caller closes it)."""
    base, token = device_base()
    try:
        response = requests.request(
            method,
            f"{base}/device/{path}",
            json=payload,
            headers={"Authorization": "Bearer " + token, "X-PIA-Protocol": "1"},
            allow_redirects=False,
            timeout=timeout or DEVICE_TIMEOUT,
            stream=stream,
        )
    except requests.RequestException:
        raise DeviceApiError("pia_server_unreachable", UNREACHABLE_MESSAGE) from None
    if not 200 <= response.status_code < 300:
        try:
            raise _device_error(response)
        finally:
            response.close()
    if stream:
        return response
    try:
        if response.status_code == 204 or not response.content:
            return {}
        data = response.json()
    except ValueError:
        raise DeviceApiError(
            "pia_server_unreachable", UNREACHABLE_MESSAGE, response.status_code
        ) from None
    finally:
        response.close()
    return data if isinstance(data, dict) else {"items": data}
