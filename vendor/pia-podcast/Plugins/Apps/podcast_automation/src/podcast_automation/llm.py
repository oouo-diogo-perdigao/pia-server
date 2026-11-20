"""Cliente de resumos pela API Chat Completions da PIA."""

import json
import re
import time
import requests
from src.app_access import current, headers

try:
    from .settings import get_config
except ImportError:
    try:
        from podcast_automation.settings import get_config
    except ImportError:
        get_config = None

_SECRET_PATTERNS = (
    re.compile(r"Bearer\s+[^\s,;\"']+", re.IGNORECASE),
    re.compile(r"\bsk-[A-Za-z0-9_-]{8,}\b"),
    re.compile(r"\bgsk_[A-Za-z0-9_-]{8,}\b"),
    re.compile(r"\bAIza[A-Za-z0-9_-]{12,}\b"),
    re.compile(r"(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s,;\"']+", re.IGNORECASE),
)

_AUTH_503_HINTS = (
    "login",
    "autentic",
    "chave",
    "instalad",
    "desconect",
    "provedor",
    "credencia",
    "api_key",
    "unauthorized",
    "forbidden",
    "expirad",
    "recus",
)


def _load_model_selection() -> tuple[str, str]:
    if get_config is None:
        return "", ""
    try:
        config = get_config()
    except Exception:
        return "", ""
    integrations = config.get("integrations") if isinstance(config, dict) else None
    if not isinstance(integrations, dict):
        return "", ""
    provider = integrations.get("llm_provider")
    model = integrations.get("llm_model")
    return (
        provider.strip() if isinstance(provider, str) else "",
        model.strip() if isinstance(model, str) else "",
    )


def resolve_model(
    default_model: str, llm_provider: str = "", llm_model: str = ""
) -> str:
    provider = str(llm_provider or "").strip()
    model = str(llm_model or "").strip()
    if not provider and not model:
        return default_model
    if provider in ("free", "paid") and not model:
        return provider
    if model:
        if (
            provider
            and provider not in ("free", "paid")
            and model != provider
            and not model.startswith(provider + "/")
        ):
            return f"{provider}/{model}"
        return model
    return provider


def sanitize_error_message(message: str, request_headers: dict | None = None) -> str:
    sanitized = str(message)
    if request_headers:
        auth = request_headers.get("Authorization", "")
        key = auth.removeprefix("Bearer ").strip() if isinstance(auth, str) else ""
        if key:
            sanitized = sanitized.replace(key, "[chave omitida]")
        app_token = request_headers.get("X-PIA-App-Token", "")
        if isinstance(app_token, str) and app_token.strip():
            sanitized = sanitized.replace(app_token.strip(), "[token omitido]")
    for pattern in _SECRET_PATTERNS:
        sanitized = pattern.sub("[segredo omitido]", sanitized)
    sanitized = re.sub(r"https?://[^\s]+", "[URL omitida]", sanitized)
    return sanitized[:1000]


def _should_retry_http(status_code: int, detail: str) -> bool:
    if status_code not in (429, 500, 502, 503, 504):
        return False
    if status_code == 503:
        lowered = detail.lower()
        if any(hint in lowered for hint in _AUTH_503_HINTS):
            return False
    return True


class PiaClient:
    def __init__(self, llm_provider: str | None = None, llm_model: str | None = None):
        context = current()
        self.base_url = context["url"].rstrip("/") + "/v1"
        if llm_provider is None and llm_model is None:
            provider, model = _load_model_selection()
        else:
            provider = str(llm_provider or "").strip()
            model = str(llm_model or "").strip()
        self.llm_provider = provider
        self.llm_model = model
        self.model = resolve_model(context["model"], provider, model)
        self.headers = {"Content-Type": "application/json", **headers()}
        self.timeout = float(context.get("timeout", 3600))

    def complete_json(self, prompt, fields, attempts=3, *, validate=None):
        payload = {
            "model": self.model,
            "stream": False,
            "temperature": 0.2,
            "messages": [
                {
                    "role": "user",
                    "content": prompt
                    + "\nResponda SOMENTE com um objeto JSON com os campos: "
                    + ", ".join(fields),
                }
            ],
        }
        for attempt in range(attempts):
            response = None
            detail = ""
            try:
                response = requests.post(
                    self.base_url + "/chat/completions",
                    json=payload,
                    headers=self.headers,
                    timeout=self.timeout,
                )
                if response.status_code >= 400:
                    try:
                        message = response.json().get("error", {}).get("message")
                        if isinstance(message, str) and message.strip():
                            detail = " " + sanitize_error_message(message, self.headers)
                    except (ValueError, AttributeError):
                        pass
                    raise RuntimeError(
                        f"PIA retornou HTTP {response.status_code}.{detail}"
                    )
                content = response.json()["choices"][0]["message"]["content"]
                if not isinstance(content, str):
                    raise ValueError("A API não retornou conteúdo textual.")
                content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip())
                data = json.loads(content)
                if not isinstance(data, dict) or any(
                    not isinstance(data.get(k), str) or not data[k].strip()
                    for k in fields
                ):
                    raise ValueError("Resposta JSON sem os campos obrigatórios.")
            except requests.RequestException as exc:
                if attempt + 1 == attempts:
                    raise RuntimeError(
                        "Não foi possível comunicar com a PIA. Verifique se o servidor "
                        "está iniciado na mesma instalação."
                    ) from exc
            except (KeyError, IndexError, ValueError) as exc:
                if attempt + 1 == attempts:
                    raise RuntimeError(
                        "A PIA não retornou um JSON válido com os campos do resumo."
                    ) from exc
            except RuntimeError:
                if (
                    response is None
                    or not _should_retry_http(response.status_code, detail)
                    or attempt + 1 == attempts
                ):
                    raise
            else:
                if validate is None:
                    return data
                try:
                    return validate(data)
                except ValueError as exc:
                    if attempt + 1 == attempts:
                        raise RuntimeError(
                            f"A PIA não gerou um resumo válido após {attempts} "
                            f"tentativa(s). Último erro: {exc}"
                        ) from exc
            time.sleep(min(2**attempt, 30))
