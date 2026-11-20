"""Self-contained, accessible transcript reader; all episode text is in the HTML."""

import html
from pathlib import Path

ASSETS = Path(__file__).resolve().parents[2] / "web/transcripts"


def render(episodes, cover, details, campaigns=()):
    escape = lambda value: html.escape(str(value), quote=True)
    title = escape(details.get("title") or "Transcrições")
    options = []
    from urllib.parse import urlsplit

    for campaign in campaigns:
        url = campaign["url"]
        if urlsplit(url).scheme not in ("https", "http"):
            continue
        selected = (
            " selected" if campaign.get("rss_key") == details.get("rss_key") else ""
        )
        options.append(
            f'<option value="{escape(url)}"{selected}>{escape(campaign["title"])}</option>'
        )
    selector = (
        (
            '<label for="campaign">Mesa</label><select id="campaign">'
            + "".join(options)
            + "</select>"
        )
        if options
        else ""
    )
    navigation = []
    sections = []
    for index, episode in enumerate(episodes):
        identity = f"session-{index + 1}"
        name = escape(episode["title"])
        content = escape(episode["content"])
        navigation.append(f'<a href="#{identity}" data-session="{identity}">{name}</a>')
        sections.append(f'''<section id="{identity}" class="session" aria-labelledby="title-{identity}">
<header><label><input type="checkbox" class="selection" aria-label="Selecionar {name}"></label>
<h2 id="title-{identity}">{name}</h2><button data-copy="{identity}" title="Copiar esta sessão" aria-label="Copiar esta sessão">⧉ Copiar</button></header>
<pre class="transcript">{content}</pre></section>''')
    image = (
        f'<img class="cover" src="{escape(cover)}" alt="Capa da campanha">'
        if cover
        else ""
    )
    css = (ASSETS / "reader.css").read_text(encoding="utf-8")
    js = (ASSETS / "reader.js").read_text(encoding="utf-8")
    return f"""<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · Transcrições · PIA</title><style>{css}</style></head>
<body><aside>{image}<span class="brand">PIA / PODCAST AUTOMATION</span>{selector}<h1>{title}</h1>
<label for="search">Pesquisar sessões e falas</label><input id="search" type="search" placeholder="Digite para pesquisar…">
<p id="count" role="status">{len(episodes)} sessões</p><nav aria-label="Sessões">{"".join(navigation)}</nav></aside>
<main><div class="toolbar"><label><input id="select-visible" type="checkbox"> Selecionar resultados</label>
<button id="copy-selected" disabled>⧉ Copiar selecionadas <span id="selected-count"></span></button><a href="#top">↑ Início</a></div>
<div id="top"></div>{"".join(sections) or "<p>Nenhuma transcrição publicada.</p>"}</main>
<div id="feedback" role="status" hidden></div><script>{js}</script></body></html>"""
