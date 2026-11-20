"""Optional publication announcements through shared PIA connectors."""

import requests
import re
from src.app_access import current, headers
from .settings import get_config


def publication_text(episode, campaign, links, season, number):
    code = (
        f"S{int(season):02d}E{int(number):02d}"
        if season is not None and number is not None
        else ""
    )
    links = links or {}
    entries = {
        "MP3": links.get("MP3"),
        "RSS": links.get("RSS"),
        "TRANSCRIÇÃO": links.get("Transcrições gerais") or links.get("Transcrição TXT"),
    }
    lines = [" - ".join(part for part in (campaign, code, episode) if part)]
    lines.extend(
        f"{label}: {url}"
        for label, url in entries.items()
        if isinstance(url, str) and url.startswith(("https://", "http://"))
    )
    return "\n".join(lines)


def message_parts(text, limit, service):
    message = ""
    for line in text.splitlines():
        if len(line) > limit:
            raise ValueError(
                f"Um link de publicação excede o limite de mensagem da plataforma {service}."
            )
        if message and len(message) + len(line) + 1 > limit:
            yield message
            message = ""
        message = (message + "\n" + line).strip()
    if message:
        yield message


def announce_publication(
    episode, campaign, links=None, season=None, number=None, players=()
):
    config = get_config()
    options = config.get("integrations", {})
    text = f"Episódio '{episode}' da mesa {campaign} publicado."
    ok = True
    if options.get("announce"):
        try:
            response = requests.post(
                current()["url"] + "/tts/speak",
                json={"text": text},
                headers=headers(),
                timeout=30,
            )
            ok = response.status_code == 200
        except requests.RequestException:
            ok = False
    if options.get("discord_notify"):
        try:
            from Plugins.Connectors.discord.service import Discord

            discord_text = publication_text(episode, campaign, links, season, number)
            mapping = config.get("discord_users", {})
            if not isinstance(mapping, dict):
                raise ValueError(
                    "discord_users deve mapear nomes de jogadores para IDs do Discord."
                )
            mentions = list(
                dict.fromkeys(
                    str(mapping[player])
                    for player in players
                    if player in mapping
                    and re.fullmatch(r"[0-9]{1,20}", str(mapping[player]))
                )
            )
            if mentions:
                discord_text += "\n" + " ".join(
                    "<@" + identity + ">" for identity in mentions
                )
            messages = list(message_parts(discord_text, 2000, "Discord"))
            channels = options.get("discord_channels") or [
                options.get("discord_channel")
            ]
            for channel in dict.fromkeys(channels):
                for message in messages:
                    if mentions:
                        Discord().send(message, channel, mentions=mentions)
                    else:
                        Discord().send(message, channel)
        except Exception:
            print(
                "Aviso: Discord não confirmou a notificação; os arquivos continuam publicados."
            )
            ok = False
    if options.get("taverns_notify"):
        try:
            from Plugins.Connectors.taverns.service import MESSAGE_LIMIT, Taverns

            channels = options.get("taverns_channels") or []
            if not channels:
                raise ValueError("Selecione um canal de publicação.")
            messages = list(
                message_parts(
                    publication_text(episode, campaign, links, season, number),
                    MESSAGE_LIMIT,
                    "Tav.gg",
                )
            )
            bot = Taverns()
            for destination in dict.fromkeys(channels):
                try:
                    for message in messages:
                        bot.send(message, destination)
                except (ValueError, RuntimeError) as error:
                    print(
                        f"Aviso: Tav.gg não confirmou a notificação em um canal. {error}"
                    )
                    ok = False
        except Exception:
            print(
                "Aviso: Tav.gg não confirmou a notificação; confira o conector e os canais selecionados."
            )
            ok = False
    return ok
