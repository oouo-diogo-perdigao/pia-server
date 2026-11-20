from .settings import option
from src.user_paths import user_path
from .ui_events import emit, stage
import os
import shutil
import time
import zipfile
import traceback
from datetime import datetime, timezone
from pathlib import Path


from .audioManager import AudioManager
from .geradorResumoSessao import GeradorResumoSessao
from .googleDriveClient import GoogleDriveClient
from .localDriveClient import LocalDriveClient
from .objectStorageManager import ObjectStorageManager
from .transcritorWhisper import TranscritorWhisper
from .rssTranscriptionUpdate import RssTranscriptionUpdater


from .settings import get_config, env_bool, project_path, output_formats
from .notification import announce_publication


def configure():
    global \
        NomesReais, \
        CampaignDetails, \
        LIMITE_DIFERENCA_ZIP, \
        LIMITE_DIFERENCA_DATA, \
        PUBLICAR_DIRETO
    config = get_config()
    NomesReais = config["nomes_reais"]
    CampaignDetails = config["campaign_details"]
    LIMITE_DIFERENCA_ZIP = config["processing"]["duplicate_max_bytes"]
    LIMITE_DIFERENCA_DATA = config["processing"]["duplicate_max_seconds"]
    PUBLICAR_DIRETO = env_bool("PUBLICAR_DIRETO")


def converter_data(valor) -> datetime:
    if isinstance(valor, (int, float)):
        return datetime.fromtimestamp(valor, tz=timezone.utc)

    texto = str(valor or "").strip()
    if not texto:
        return datetime.max.replace(tzinfo=timezone.utc)

    if texto.endswith("Z"):
        texto = texto[:-1] + "+00:00"

    data = datetime.fromisoformat(texto)
    if data.tzinfo is None:
        data = data.replace(tzinfo=timezone.utc)
    return data.astimezone(timezone.utc)


def data_criacao(item: dict) -> datetime:
    return converter_data(item.get("createdTime") or item.get("modifiedTime"))


def extrair_zip(local_zip: Path, nome_zip: str) -> str:
    pasta_extraida = Path(nome_zip).with_suffix("").name
    pasta = Path(pasta_extraida)

    if pasta.is_dir() and any(pasta.iterdir()):
        print(f"Pulando extração; pasta já existe e não está vazia: {pasta}")
        return str(pasta)

    pasta.mkdir(parents=True, exist_ok=True)
    print(f"Extraindo {local_zip} para {pasta}")
    with zipfile.ZipFile(local_zip, "r") as zip_ref:
        zip_ref.extractall(pasta)
    return str(pasta)


def limpar_temporarios(pasta_extraida: str, caminho_zip: str) -> None:
    print(f"Limpando pasta extraída: {pasta_extraida}")
    try:
        if os.path.exists(pasta_extraida):
            shutil.rmtree(pasta_extraida)
    except Exception as erro:
        print(f"Aviso: erro ao limpar pasta extraída {pasta_extraida}: {erro}")
    print(f"Removendo ZIP local: {caminho_zip}")
    try:
        if caminho_zip and os.path.exists(caminho_zip):
            os.remove(caminho_zip)
    except Exception as erro:
        print(f"Aviso: erro ao remover ZIP local {caminho_zip}: {erro}")


def criar_assinatura(item: dict, audio: AudioManager) -> dict:
    """
    Preenche narrador, jogadores, personagens, tamanho_zip, data_criacao e arquivo para a sessão.
    """
    return {
        "narrador": audio.narrador,
        "jogadores": tuple(sorted(audio.jogadores)),
        "personagens": tuple(sorted(audio.personagens)),
        "tamanho_zip": int(item.get("size") or os.path.getsize(item["local_zip"])),
        "data_criacao": data_criacao(item),
        "arquivo": item["name"],
    }


def localizar_duplicada(
    assinatura: dict,
    sessoes_processadas: list[dict],
) -> dict | None:
    for anterior in sessoes_processadas:
        mesmos_participantes = (
            assinatura["narrador"] == anterior["narrador"]
            and assinatura["jogadores"] == anterior["jogadores"]
            and assinatura["personagens"] == anterior["personagens"]
        )
        diferenca_tamanho = abs(assinatura["tamanho_zip"] - anterior["tamanho_zip"])
        diferenca_data = abs(
            (assinatura["data_criacao"] - anterior["data_criacao"]).total_seconds()
        )

        if (
            mesmos_participantes
            and diferenca_tamanho <= LIMITE_DIFERENCA_ZIP
            and diferenca_data <= LIMITE_DIFERENCA_DATA
        ):
            return anterior

    return None


def subpasta_jogo(campanha: str) -> str:
    return AudioManager.nome_seguro(campanha)


def obter_prefixo_publicacao(item: dict) -> str:
    if PUBLICAR_DIRETO:
        rss_key = item.get("rss_key")

        if not rss_key:
            raise RuntimeError(
                "PUBLICAR_DIRETO está ativo, mas a sessão não possui rss_key."
            )

        return rss_key.rsplit("/", 1)[0]

    return f"{get_config()['publication']['unpublished_prefix']}/{subpasta_jogo(item['campanha'])}"


def publicar_sessao(
    obj_storage: ObjectStorageManager,
    item: dict,
) -> None:
    prefixo = obter_prefixo_publicacao(item)

    modo = (
        "pasta final do RSS"
        if PUBLICAR_DIRETO
        else get_config()["publication"]["unpublished_prefix"]
    )
    print(f"Publicando arquivos em {modo}: {prefixo}")

    formats = output_formats()
    arquivos = [{"caminho": item["audio_path"], "content_type": "audio/mpeg"}]
    for format, key, mime in [
        ("srt", "srt_path", "text/plain; charset=utf-8"),
        ("vtt", "vtt_path", "text/vtt; charset=utf-8"),
        ("txt", "roteiro_path", "text/plain; charset=utf-8"),
        ("resumo.json", "resumo_json_path", "application/json"),
    ]:
        path = item.get(key)
        if formats[format] and path and os.path.isfile(path):
            arquivos.append({"caminho": path, "content_type": mime})

    for arquivo in arquivos:
        caminho = arquivo["caminho"]
        content_type = arquivo["content_type"]
        nome_destino = arquivo.get("nome_destino", os.path.basename(caminho))

        chave = f"{prefixo}/{nome_destino}"

        obj_storage.sendObject(
            caminho,
            chave,
            content_type,
        )
        url = obj_storage.public_url(chave)
        emit("artifact", name=nome_destino, url=url)
        if caminho == item.get("audio_path"):
            item.setdefault("publication_links", {})["MP3"] = url
        elif caminho == item.get("roteiro_path"):
            item.setdefault("publication_links", {})["Transcrição TXT"] = url


def finalizar_publicacao(
    item, drive, obj_storage, rss_updater, sessoes_processadas, assinatura
):
    """Only commit the source/cleanup after both feed derivatives were rebuilt."""
    folder_rss = item["rss_key"].rsplit("/", 1)[0]
    stage(9)
    result = rss_updater.updateRssTranscriptionFiles(folder=folder_rss)
    if (
        not isinstance(result, dict)
        or result.get("success") is not True
        or not any(
            folder.get("folder") == folder_rss for folder in result.get("folders", [])
        )
    ):
        errors = result.get("errors", []) if isinstance(result, dict) else []
        detail = (
            "; ".join(str(error.get("erro", error)) for error in errors)
            or "A campanha não foi atualizada."
        )
        raise RuntimeError(
            "Falha ao atualizar RSS e transcrições: "
            + detail
            + " O ZIP e os arquivos locais foram preservados; a origem não foi marcada como processada."
        )
    emit("artifact", name="RSS", url=obj_storage.public_url(item["rss_key"]))
    emit(
        "artifact",
        name="Transcrições",
        url=obj_storage.public_url(folder_rss + "/transcripts.html"),
    )
    drive.rename_processed(item["id"], item["name"])
    stage(10)
    sessoes_processadas.append(assinatura)
    limpar_temporarios(item["pasta_extraida"], item["local_zip"])
    emit("complete")
    print("Sessão publicada com sucesso!")
    links = {
        **item.get("publication_links", {}),
        "RSS": obj_storage.public_url(item["rss_key"]),
        "Transcrições gerais": obj_storage.public_url(folder_rss + "/transcripts.html"),
    }
    announce_publication(
        item["nome_sessao"],
        item["campanha"],
        links,
        season=item.get("season"),
        number=item.get("episode"),
        players=item.get("jogadores", ()),
    )


def metadados_da_sessao(pasta_extraida, nome, drive):
    metadata = AudioManager.ler_metadados_da_gravacao(Path(pasta_extraida))
    if not isinstance(metadata, dict) or not metadata:
        return {}
    for name, fields in (
        (nome, ("sessionTitle", "seasonEnd")),
        (metadata.get("previousRecordingName"), ("seasonEnd",)),
    ):
        if not isinstance(name, str) or not name.lower().endswith(".zip"):
            continue
        companion = drive.recording_metadata(name)
        if not companion or companion.get("channelId") != metadata.get("channelId"):
            continue
        for field in fields:
            if field in companion:
                destination = "startsSeason" if name != nome else field
                metadata[destination] = companion[field]
    return metadata


def processar_sessao(
    item: dict,
    drive,
    obj_storage: ObjectStorageManager,
    rss_updater: RssTranscriptionUpdater,
    whisper: TranscritorWhisper,
    sessoes_processadas: list[dict],
) -> None:
    print("\n========================================")
    print(f"Processando sessão: {item['name']}")
    print("========================================")

    emit("session", name=item["name"])
    stage(0)
    local_zip = drive.download_file(item)
    item["local_zip"] = str(local_zip)
    stage(1)
    item["pasta_extraida"] = extrair_zip(local_zip, item["name"])

    metadata = metadados_da_sessao(item["pasta_extraida"], item["name"], drive)
    from Plugins.Apps.podcast_automation.recording_queue import waiting_for_metadata

    if waiting_for_metadata(metadata.get("metadataEditableUntil")):
        print(
            "A sessão ainda pode ser nomeada no Discord. O processamento aguardará o prazo."
        )
        return

    audio = AudioManager(
        item["name"],
        item["pasta_extraida"],
        NomesReais,
        CampaignDetails,
        obj_storage,
        **({"recording_metadata": metadata} if metadata else {}),
    )

    # ============================================================
    # IGNORA SESSÕES COM MENOS DE 30 MINUTOS
    # ============================================================
    duracao = AudioManager.obter_duracao_audio(audio.arquivos_participantes)

    print(f"Duração da sessão: {AudioManager.formatar_tempo(duracao)}")

    if duracao < get_config()["processing"]["minimum_session_seconds"]:
        print("Sessão abaixo da duração mínima configurada — marcando como ok-omitido.")

        drive.rename_processed(
            item["id"],
            item["name"],
            status="ok-omitido",
        )

        limpar_temporarios(
            item["pasta_extraida"],
            item["local_zip"],
        )

        emit("skipped", reason="Sessão abaixo da duração mínima")
        return

    # ============================================================
    # PROCESSAMENTO NORMAL
    # ============================================================

    assinatura = criar_assinatura(item, audio)
    duplicada = localizar_duplicada(
        assinatura,
        sessoes_processadas,
    )

    if duplicada:
        print(f"Sessão duplicada detectada. Equivalente a: {duplicada['arquivo']}")

        drive.rename_processed(
            item["id"],
            item["name"],
        )

        limpar_temporarios(
            item["pasta_extraida"],
            item["local_zip"],
        )

        emit("skipped", reason="Sessão duplicada")
        return

    stage(2)
    item["mix_path"] = audio.mix()
    stage(3)
    item["audio_path"] = audio.build()
    item["edit_timeline"] = audio.edit_timeline
    item["arquivos_participantes"] = audio.arquivos_participantes
    item["grupos_transcricao"] = audio.grupos_transcricao

    item["campanha"] = audio.campanha
    item["narrador"] = audio.narrador
    item["personagens"] = audio.personagens
    item["jogadores"] = audio.jogadores
    item["season"] = audio.session
    item["episode"] = audio.episode
    item["ouvintes"] = audio.ouvintes
    item["rss_key"] = audio.rss

    formats = output_formats()
    transcribe = any(formats[name] for name in ("srt", "vtt", "txt", "resumo.json"))
    gerador = None
    if transcribe:
        stage(4)
        whisper.carregar_pasta(item)
        whisper.build()
        if getattr(whisper, "cache_rebuilt", False) is True:
            old = Path(whisper.roteiro_path).with_suffix(".resumo.json")
            for cached in (old, old.with_suffix(".llm.json")):
                if cached.resolve().is_relative_to(
                    Path(item["pasta_extraida"]).resolve()
                ):
                    cached.unlink(missing_ok=True)
        stage(5)
        if formats["srt"]:
            item["srt_path"] = whisper.gravar_srt()
        if formats["vtt"]:
            item["vtt_path"] = whisper.gravar_vtt()
        if formats["txt"] or formats["resumo.json"]:
            item["roteiro_path"] = whisper.gravar_roteiro()
    titulo_gravacao = audio.recording_metadata.get("sessionTitle")
    if not isinstance(titulo_gravacao, str):
        titulo_gravacao = ""
    item["nome_sessao"] = (
        titulo_gravacao
        or item.get("nome_sessao")
        or f"Sessão {audio.session} · Episódio {audio.episode}"
    )
    if formats["resumo.json"]:
        stage(6)
        gerador = GeradorResumoSessao(
            campanha=item["campanha"],
            narrador=item["narrador"],
            personagens=item["personagens"],
            jogadores=item["jogadores"],
            ouvintes=item["ouvintes"],
            roteiro_path=item["roteiro_path"],
            obj_storage=obj_storage,
            rss_key=item["rss_key"],
        )
        titulo_gerado, item["resumo_rapido"], item["resumo_completo"] = (
            gerador.gerar_resumo()
        )
        item["nome_sessao"] = titulo_gravacao or titulo_gerado
        if formats["txt"]:
            gerador.incluir_resumo_no_roteiro(item)
    stage(7)
    caminhos_audio = audio.renomear_arquivos(item["nome_sessao"])
    if transcribe:
        caminhos_texto = whisper.renomear_arquivos(item["nome_sessao"])
        item.update(caminhos_texto)
        if gerador:
            item.update(
                gerador.renomear_arquivos(
                    item["nome_sessao"], caminhos_texto["roteiro_path"]
                )
            )
        # The summary may use an internal script without exporting a TXT artifact.
        if not formats["txt"] and item.get("roteiro_path"):
            Path(item["roteiro_path"]).unlink(missing_ok=True)
    audio.alterar_title(item["nome_sessao"])

    item["mix_path"] = caminhos_audio["audio_mix_path"]
    item["audio_path"] = caminhos_audio["audio_path"]

    stage(8)
    publicar_sessao(
        obj_storage,
        item,
    )

    finalizar_publicacao(
        item, drive, obj_storage, rss_updater, sessoes_processadas, assinatura
    )


def main() -> None:
    print("========================================")
    print("Iniciando processamento Craig")
    print("========================================")

    configure()
    if env_bool("DRIVE_PROCESS", True):
        drive = GoogleDriveClient()
        folder_path = (
            get_config().get("integrations", {}).get("google_folder")
            or drive.plugin.default_folder
        )
        if not folder_path:
            raise RuntimeError(
                "Selecione uma pasta do Google Drive no painel do podcast."
            )
    else:
        drive = LocalDriveClient()
        folder_path = str(
            project_path(option("LOCAL_DRIVE_FOLDER", "data/local-drive"))
        )

    drive_files = drive.list_zip_files(folder_path)
    if not drive_files:
        print("Nenhum ZIP encontrado.")
        return

    for arquivo in drive_files:
        estado = (
            " (Processado)"
            if arquivo["name"].lower().endswith(("-ok.zip", "-ok-omitido.zip"))
            else ""
        )
        print(f"* {arquivo['name']}{estado}")

    from Plugins.Apps.podcast_automation.recording_queue import pending_files

    pendentes = pending_files(drive_files)
    pendentes.sort(key=data_criacao)

    if not pendentes:
        print("Nenhum ZIP novo para processar.")
        return

    obj_storage = ObjectStorageManager()
    rss_updater = RssTranscriptionUpdater(obj_storage)
    whisper = TranscritorWhisper(NomesReais, CampaignDetails)
    sessoes_processadas: list[dict] = []

    try:
        for item in pendentes:
            processar_sessao(
                item,
                drive,
                obj_storage,
                rss_updater,
                whisper,
                sessoes_processadas,
            )
    finally:
        whisper.descarregar_modelo()


def run() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Processador Craig")
    parser.add_argument(
        "--once", action="store_true", help="Verifica a pasta uma vez, sem repetir"
    )
    args = parser.parse_args()
    configure()
    work = user_path("apps/podcast_automation/work")
    work.mkdir(parents=True, exist_ok=True)
    os.chdir(work)
    interval = int(option("POLL_INTERVAL_SECONDS", "600"))
    if interval < 1:
        raise ValueError("POLL_INTERVAL_SECONDS deve ser positivo.")
    while True:
        if args.once:
            try:
                main()
            except Exception as exc:
                emit("failed", error=str(exc))
                raise
            return
        try:
            main()
        except Exception:
            emit("failed")
            traceback.print_exc()
        emit("waiting", seconds=interval)
        print(f"Aguardando {interval} segundos")
        time.sleep(interval)


if __name__ == "__main__":
    run()
