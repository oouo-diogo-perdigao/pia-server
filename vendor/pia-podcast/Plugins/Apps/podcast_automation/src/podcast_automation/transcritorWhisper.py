from src.stt_recovery import find_repetition
from src.transcription import repair_point_segments
from .audioEditing import map_time
import os
import json
import hashlib
import math
import re
from tqdm import tqdm
from dataclasses import dataclass
from pathlib import Path
from typing import List, Tuple
from .piaTranscription import PiaTranscription
from .audioManager import AudioManager


@dataclass
class SegmentoFala:
    """Classe de dados representando uma frase dita por um participante com marcações temporais."""

    inicio: float
    fim: float
    autor: str
    texto: str


class TranscritorWhisper:
    """
    Transcreve áudios individuais pela PIA e gera JSON, SRT, roteiro e VTT.
    """

    def __init__(self, nomes_reais: dict, campaign_details: dict):
        self.nomes_reais = nomes_reais
        self.campaign_details = campaign_details
        self.pia = PiaTranscription()
        self.edit_timeline = []
        self.cache_rebuilt = False

    def carregar_modelo(self):
        """Provider choice and model lifetime are managed by PIA."""
        return None

    def descarregar_modelo(self):
        return None

    def carregar_pasta(self, item: dict) -> None:
        self.pasta_extraida = item["pasta_extraida"]
        self.edit_timeline = item.get("edit_timeline", [])
        mp3Name = os.path.splitext(os.path.basename(item["audio_path"]))[0]
        self.arquivos_participantes = item["arquivos_participantes"]
        self.grupos_transcricao = item["grupos_transcricao"]
        self.srt_path = os.path.join(self.pasta_extraida, f"{mp3Name}.srt")
        self.vtt_path = os.path.join(self.pasta_extraida, f"{mp3Name}.vtt")
        self.roteiro_path = os.path.join(self.pasta_extraida, f"{mp3Name}.txt")
        self.json_paths = {
            pessoa: os.path.join(
                self.pasta_extraida,
                f"{mp3Name}.{self.nome_seguro(pessoa)}.json",
            )
            for pessoa in self.grupos_transcricao
        }

    @staticmethod
    def nome_seguro(nome: str) -> str:
        nome = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", str(nome)).strip()
        return re.sub(r"\s+", " ", nome).strip(" .") or "Desconhecido"

    def build(self):
        self.processar_participantes()
        self.ler_segmentos()
        self.mesclar_falas_sobrepostas()

    def processar_participantes(self):
        """
        Recebe a lista dos áudios extraídos, identifica os participantes e executa
        a transcrição em lote com VAD (Voice Activity Detection), gerando um JSON por jogador.
        """
        grupos_pendentes = []

        for nome_jogador, arquivos in self.grupos_transcricao.items():
            caminho_saida = self.json_paths[nome_jogador]

            if os.path.isfile(caminho_saida):
                try:
                    with open(caminho_saida, encoding="utf-8") as cached:
                        rows = json.load(cached)
                    if not isinstance(rows, list):
                        raise ValueError("Cache de transcrição inválido.")
                    if any(
                        not isinstance(row.get("texto"), str)
                        or not all(
                            isinstance(row.get(key), (int, float))
                            and math.isfinite(row[key])
                            for key in ("inicio", "fim")
                        )
                        or row["inicio"] < 0
                        or row["fim"] < row["inicio"]
                        for row in rows
                    ):
                        raise ValueError("Cache sem timestamps válidos.")
                    certificate = Path(caminho_saida).with_suffix(".stt-validated.json")
                    digest = hashlib.sha256(
                        Path(caminho_saida).read_bytes()
                    ).hexdigest()
                    verified = (
                        json.loads(certificate.read_text(encoding="utf-8"))
                        if certificate.exists()
                        else {}
                    )
                    healthy = (
                        verified.get("version") == 2
                        and verified.get("sha256") == digest
                    ) or not find_repetition(
                        [
                            {
                                "start": row["inicio"],
                                "end": row["fim"],
                                "text": row["texto"],
                            }
                            for row in rows
                        ]
                    )
                    if healthy:
                        print(
                            f"Pulando ({caminho_saida}) transcrição já existe e foi validada"
                        )
                        continue
                    print(
                        f"Cache com repetição suspeita: {caminho_saida}; retranscrevendo pela PIA."
                    )
                except (ValueError, KeyError, TypeError, AttributeError):
                    print(f"Cache inválido: {caminho_saida}; retranscrevendo pela PIA.")
                self.cache_rebuilt = True

            grupos_pendentes.append((arquivos, nome_jogador, caminho_saida))

        if not grupos_pendentes:
            print(
                "Pulando Todas as transcrições JSON já existem; modelo não será carregado"
            )
            return

        self.carregar_modelo()

        total_files = sum(len(files) for files in self.grupos_transcricao.values())
        completed_files = total_files - sum(len(group[0]) for group in grupos_pendentes)

        total_jogadores = len(grupos_pendentes)

        duracoes_por_arquivo = {}
        grupos_com_duracao = []

        for arquivos, nome_jogador, caminho_saida in grupos_pendentes:
            duracao_total_jogador = 0.0

            for arquivo in arquivos:
                duracao_arquivo = AudioManager.obter_duracao_audio([arquivo])
                duracoes_por_arquivo[arquivo] = duracao_arquivo
                duracao_total_jogador += duracao_arquivo

            grupos_com_duracao.append(
                (
                    arquivos,
                    nome_jogador,
                    caminho_saida,
                    duracao_total_jogador,
                )
            )

        duracao_total_geral = sum(
            duracao_total_jogador
            for _, _, _, duracao_total_jogador in grupos_com_duracao
        )

        progresso_total_geral = 0.0

        def formatar_postfix(progresso, duracao_total):
            restante = max(0.0, duracao_total - progresso)

            str_progresso = AudioManager.formatar_tempo(progresso)
            str_restante = AudioManager.formatar_tempo(restante)
            str_duracao_total = AudioManager.formatar_tempo(duracao_total)

            return f"[{str_progresso}<{str_restante}] {str_duracao_total}"

        barra_total = tqdm(
            disable=os.getenv("CRAIG_GUI_EVENTS") == "1",
            total=duracao_total_geral,
            desc="Transcrição Geral",
            position=0,
            leave=True,
            dynamic_ncols=True,
            bar_format="{desc}: {percentage:3.0f}%|{bar}| {postfix}",
        )

        barra_total.set_postfix_str(
            formatar_postfix(0.0, duracao_total_geral),
            refresh=False,
        )

        try:
            for indice_jogador, (
                arquivos,
                nome_jogador,
                caminho_saida,
                duracao_total_jogador,
            ) in enumerate(grupos_com_duracao, start=1):
                resultado = []
                progresso_jogador = 0.0

                barra_jogador = tqdm(
                    disable=os.getenv("CRAIG_GUI_EVENTS") == "1",
                    total=duracao_total_jogador,
                    desc=f"Transcrevendo ({nome_jogador}) {indice_jogador}/{total_jogadores}",
                    position=1,
                    leave=False,
                    dynamic_ncols=True,
                    bar_format="{desc}: {percentage:3.0f}%|{bar}| {postfix}",
                )

                barra_jogador.set_postfix_str(
                    formatar_postfix(0.0, duracao_total_jogador),
                    refresh=False,
                )

                def atualizar_barras(incremento):
                    nonlocal progresso_total_geral, progresso_jogador

                    if incremento <= 0:
                        return

                    incremento_jogador = min(
                        incremento,
                        max(0.0, duracao_total_jogador - progresso_jogador),
                    )

                    incremento_geral = min(
                        incremento,
                        max(0.0, duracao_total_geral - progresso_total_geral),
                    )

                    progresso_jogador += incremento_jogador
                    progresso_total_geral += incremento_geral

                    barra_jogador.update(incremento_jogador)
                    barra_total.update(incremento_geral)

                    barra_jogador.set_postfix_str(
                        formatar_postfix(progresso_jogador, duracao_total_jogador),
                        refresh=False,
                    )

                    barra_total.set_postfix_str(
                        formatar_postfix(progresso_total_geral, duracao_total_geral),
                        refresh=False,
                    )

                    barra_jogador.refresh()
                    barra_total.refresh()

                try:
                    for caminho_arquivo in arquivos:
                        duracao_arquivo = duracoes_por_arquivo.get(caminho_arquivo, 0.0)

                        self.pia.progress_context = {
                            "total": total_files,
                            "completed": completed_files,
                            "label": "Transcrever",
                        }
                        segmentos = self.pia.transcribe(
                            caminho_arquivo, duracao_arquivo
                        )
                        informacoes = None

                        ultimo_segmento = 0.0
                        progresso_arquivo = 0.0

                        for seg in segmentos:
                            texto_limpo = seg.text.strip()

                            if texto_limpo:
                                resultado.append(
                                    SegmentoFala(
                                        inicio=seg.start,
                                        fim=seg.end,
                                        autor=nome_jogador,
                                        texto=texto_limpo,
                                    )
                                )

                            if seg.end > ultimo_segmento:
                                incremento = seg.end - ultimo_segmento
                                ultimo_segmento = seg.end
                                progresso_arquivo += incremento

                                atualizar_barras(incremento)

                        # Garante que a barra avance até o fim do arquivo mesmo
                        # quando houver silêncio, VAD agressivo ou poucos segmentos detectados.
                        restante_arquivo = max(0.0, duracao_arquivo - progresso_arquivo)

                        if restante_arquivo > 0:
                            atualizar_barras(restante_arquivo)

                        completed_files += 1
                        from podcast_automation.ui_events import emit

                        emit(
                            "progress",
                            state="completed",
                            label="Transcrever",
                            processed=duracao_arquivo,
                            duration=duracao_arquivo,
                            percent=100,
                            total=total_files,
                            completed=completed_files,
                            speed=getattr(self.pia, "last_speed", 0),
                        )

                        if informacoes is not None:
                            tqdm.write(
                                f"Idioma Detectado: {informacoes.language} "
                                f"(Confiança: {informacoes.language_probability:.2f})"
                            )

                    # Garante fechamento exato da barra do jogador, evitando diferença por arredondamento.
                    restante_jogador = max(
                        0.0, duracao_total_jogador - progresso_jogador
                    )

                    if restante_jogador > 0:
                        atualizar_barras(restante_jogador)

                    barra_jogador.n = duracao_total_jogador
                    barra_jogador.set_postfix_str(
                        formatar_postfix(duracao_total_jogador, duracao_total_jogador),
                        refresh=False,
                    )
                    barra_jogador.refresh()

                finally:
                    barra_jogador.close()

                resultado.sort(key=lambda segmento: (segmento.inicio, segmento.fim))

                unicos = []
                vistos = set()

                for segmento in resultado:
                    chave = (
                        round(segmento.inicio, 3),
                        round(segmento.fim, 3),
                        segmento.texto,
                    )

                    if chave not in vistos:
                        vistos.add(chave)
                        unicos.append(segmento)

                temporary = Path(caminho_saida).with_suffix(".json.tmp")
                with temporary.open("w", encoding="utf-8") as f:
                    json.dump(
                        [seg.__dict__ for seg in unicos],
                        f,
                        ensure_ascii=False,
                        indent=2,
                    )

                temporary.replace(caminho_saida)
                certificate = Path(caminho_saida).with_suffix(".stt-validated.json")
                from src.resource_plugins import save_json

                save_json(
                    certificate,
                    {
                        "version": 2,
                        "sha256": hashlib.sha256(
                            Path(caminho_saida).read_bytes()
                        ).hexdigest(),
                    },
                )
                tqdm.write(
                    f"Arquivo JSON gerado para {nome_jogador}: {caminho_saida}\n"
                )

            barra_total.n = duracao_total_geral
            barra_total.set_postfix_str(
                formatar_postfix(duracao_total_geral, duracao_total_geral),
                refresh=False,
            )
            barra_total.refresh()

        finally:
            barra_total.close()

    def ler_segmentos(self) -> List[SegmentoFala]:
        """Carrega todos os arquivos JSON do diretório e os unifica ordenando por tempo de início."""
        self.segmentos: List[SegmentoFala] = []
        for caminho_arquivo in self.json_paths.values():
            if not os.path.isfile(caminho_arquivo):
                continue
            with open(caminho_arquivo, encoding="utf-8") as f:
                dados = json.load(f)
                # Old participant caches may already contain point annotations.
                # Repair before subtitle merging so their text is not dropped.
                rows = sorted(
                    [
                        {
                            **item,
                            "start": float(item.get("inicio", 0)),
                            "end": float(item.get("fim", item.get("inicio", 0))),
                        }
                        for item in dados
                    ],
                    key=lambda row: row["start"],
                )
                rows, _ = repair_point_segments(
                    rows, max((row["end"] for row in rows), default=0)
                )
                for item in rows:
                    inicio = item["start"]
                    fim = item["end"]
                    if self.edit_timeline:
                        inicio = map_time(inicio, self.edit_timeline)
                        fim = map_time(fim, self.edit_timeline)
                        if fim <= inicio:
                            continue
                    autor = item.get("autor", "")
                    texto = item.get("texto", "").strip()
                    if texto:
                        self.segmentos.append(SegmentoFala(inicio, fim, autor, texto))
        self.segmentos.sort(key=lambda x: x.inicio)
        return self.segmentos

    def mesclar_falas_sobrepostas(self) -> List[Tuple[float, float, List[str]]]:
        """Agrupa blocos de fala que acontecem em tempos concorrentes para exibição simultânea na legenda."""
        self.cues = []
        if not self.segmentos:
            return self.cues

        pontos = []
        for s in self.segmentos:
            pontos.append((s.inicio, 1))
            pontos.append((s.fim, -1))
        pontos.sort()

        intervalos = []
        ativos = 0
        ultimo_tempo = None
        for t, delta in pontos:
            if ativos > 0 and ultimo_tempo is not None and t > ultimo_tempo:
                intervalos.append((ultimo_tempo, t))
            ativos += delta
            ultimo_tempo = t

        for a, b in intervalos:
            textos = []
            for s in self.segmentos:
                if s.fim > a and s.inicio < b:
                    textos.append(s.texto)
            vistos = set()
            textos_unicos = []
            for t in textos:
                if t not in vistos:
                    vistos.add(t)
                    textos_unicos.append(t)

            if textos_unicos:
                self.cues.append((a, b, textos_unicos))

        return self.cues

    def gravar_srt(self):
        """Escreve as marcações de legenda formatadas em arquivo SRT."""

        # verifica se o arquivo srt existe e nao esta vazio, se sim, pula a gravação
        with open(self.srt_path, "w", encoding="utf-8") as f:
            for i, (aSeconds, bSeconds, textos) in enumerate(self.cues, start=1):
                h = int(aSeconds // 3600)
                m = int((aSeconds % 3600) // 60)
                s = int(aSeconds % 60)
                ms = int((aSeconds - int(aSeconds)) * 1000)
                formatTimeA = f"{h:02}:{m:02}:{s:02},{ms:03}"

                h = int(bSeconds // 3600)
                m = int((bSeconds % 3600) // 60)
                s = int(bSeconds % 60)
                ms = int((bSeconds - int(bSeconds)) * 1000)
                formatTimeB = f"{h:02}:{m:02}:{s:02},{ms:03}"

                f.write(f"{i}\n")
                f.write(f"{formatTimeA} --> {formatTimeB}\n")
                f.write("\n".join(textos) + "\n\n")

        return self.srt_path

    def gravar_vtt(self):
        # verifica se o arquivo vtt existe e nao esta vazio, se sim, pula a gravação
        with open(self.vtt_path, "w", encoding="utf-8") as f:
            f.write("WEBVTT\n\n")
            for i, (aSeconds, bSeconds, textos) in enumerate(self.cues, start=1):
                h = int(aSeconds // 3600)
                m = int((aSeconds % 3600) // 60)
                s = int(aSeconds % 60)
                ms = int((aSeconds - int(aSeconds)) * 1000)
                formatTimeA = f"{h:02}:{m:02}:{s:02}.{ms:03}"

                h = int(bSeconds // 3600)
                m = int((bSeconds % 3600) // 60)
                s = int(bSeconds % 60)
                ms = int((bSeconds - int(bSeconds)) * 1000)
                formatTimeB = f"{h:02}:{m:02}:{s:02}.{ms:03}"

                f.write(f"{formatTimeA} --> {formatTimeB}\n")
                f.write("\n".join(textos) + "\n\n")

        return self.vtt_path

    def gravar_roteiro(self):
        """Agrupa falas contínuas do mesmo participante e as escreve em formato de roteiro linear."""
        # verifica se o arquivo roteiro existe e nao esta vazio, se sim, pula a gravação
        with open(self.roteiro_path, "w", encoding="utf-8") as f:
            if not self.segmentos:
                return self.roteiro_path

            autor_atual = self.segmentos[0].autor
            ultima_linha = f"{autor_atual}: {self.segmentos[0].texto}"
            f.write(f"{ultima_linha}")

            for s in self.segmentos[1:]:
                linha = f"{s.autor}: {s.texto}"

                if linha == ultima_linha:
                    continue
                if s.autor == autor_atual:
                    f.write(f" {s.texto}")
                else:
                    autor_atual = s.autor
                    f.write(f"\n{linha}")
                ultima_linha = linha

        return self.roteiro_path

    def renomear_arquivos(self, nome_sessao: str) -> dict[str, object]:
        titulo_sessao = self.nome_seguro(nome_sessao)
        stem_atual = Path(self.roteiro_path).stem

        match = re.match(
            r"^(?P<prefixo>\d{4}-\d{2}-\d{2}\s+-\s+S\d{2}E\d{2})\s+-\s+.+$",
            stem_atual,
        )

        if match:
            base = f"{match.group('prefixo')} - {titulo_sessao}"
        else:
            base = titulo_sessao

        def renomear(caminho_atual: str, sufixo: str) -> str:
            origem = Path(caminho_atual)
            destino = origem.with_name(base + sufixo)
            if not origem.exists():
                return str(destino)
            if origem != destino:
                if destino.exists():
                    raise FileExistsError(
                        f"Não é possível renomear; destino já existe: {destino}"
                    )
                origem.rename(destino)
            return str(destino)

        self.srt_path = renomear(self.srt_path, ".srt")
        self.vtt_path = renomear(self.vtt_path, ".vtt")
        self.roteiro_path = renomear(self.roteiro_path, ".txt")

        novos_jsons = {}
        for pessoa, caminho_atual in self.json_paths.items():
            novos_jsons[pessoa] = renomear(
                caminho_atual,
                f".{self.nome_seguro(pessoa)}.json",
            )
        self.json_paths = novos_jsons

        return {
            "srt_path": self.srt_path,
            "vtt_path": self.vtt_path,
            "roteiro_path": self.roteiro_path,
            "json_paths": dict(self.json_paths),
        }
