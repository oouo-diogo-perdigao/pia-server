import json
from datetime import datetime
from .settings import get_config
from .ui_events import emit
from .audioEditing import edit_pauses, save_timeline
import os
import re
import subprocess
import tempfile
from tqdm import tqdm
from collections import defaultdict
from pathlib import Path
from typing import List, Optional, Tuple
import xml.etree.ElementTree as ET
from .objectStorageManager import ObjectStorageManager


class AudioManager:
    """Classe responsável por realizar a mixagem e pós-processamento dos áudios usando FFmpeg."""

    def __init__(
        self,
        name: str,
        pasta_extraida: str,
        NomesReais: dict,
        PersonagensDoJogo: dict,
        object_storage_manager: ObjectStorageManager,
        recording_metadata: dict | None = None,
    ):
        self.diretorio_dados = next(
            item.path
            for item in os.scandir(pasta_extraida)
            if item.is_dir() and item.name.endswith("_data")
        )
        self.object_storage_manager: ObjectStorageManager = object_storage_manager
        self.name = name
        self.pasta_extraida = pasta_extraida
        self.recording_metadata = (
            recording_metadata
            if recording_metadata is not None
            else self.ler_metadados_da_gravacao(Path(pasta_extraida))
        )
        self.track_usernames = self.ler_nomes_das_faixas(self.recording_metadata)
        self.NomesReais = NomesReais
        self.PersonagensDoJogo = PersonagensDoJogo
        self.arquivos_participantes = self.listar_arquivos_participantes()
        (
            self.narrador,
            self.jogadores,
            self.personagens,
            self.ouvintes,
            self.campanha,
            self.rss,
        ) = self.deduzir_participantes()
        self.session, self.episode = self.obter_temporada_episodio()
        if self.recording_metadata.get("startsSeason") is True and self.episode > 1:
            self.session, self.episode = self.session + 1, 1
        self.ano, self.mes, self.dia = self.data_da_gravacao(self.name).split("-")
        self.dataJogo = f"{self.ano}-{self.mes}-{self.dia}"
        self.audio_mix_path = None
        self.audio_path = None
        self.edit_timeline = []

    @staticmethod
    def nome_seguro(nome: str) -> str:
        nome = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", str(nome)).strip()
        nome = re.sub(r"\s+", " ", nome)
        return nome.strip(" .") or "Sessao sem nome"

    @staticmethod
    def data_da_gravacao(nome: str) -> str:
        pia = re.search(r"(\d{8})\d{9}-", nome)
        if pia:
            return datetime.strptime(pia[1], "%Y%m%d").date().isoformat()
        ano, mes, dia = nome.split("_")[-2].split("-")
        return f"{ano}-{mes.zfill(2)}-{dia.zfill(2)}"

    @staticmethod
    def ler_metadados_da_gravacao(pasta: Path) -> dict:
        arquivo = pasta / "pia-session.json"
        if not arquivo.is_file():
            return {}
        with arquivo.open(encoding="utf-8") as entrada:
            dados = json.load(entrada)
        if not isinstance(dados, dict) or dados.get("source") != "pia-server-discord":
            return {}
        return dados

    @staticmethod
    def ler_nomes_das_faixas(dados: dict) -> dict[str, str]:
        faixas = dados.get("tracks")
        if not isinstance(faixas, list):
            return {}
        return {
            faixa["filename"]: faixa["username"]
            for faixa in faixas
            if isinstance(faixa, dict)
            and isinstance(faixa.get("filename"), str)
            and isinstance(faixa.get("username"), str)
        }

    def identificar_pessoa(self, caminho_arquivo: str) -> str:
        nome_base = os.path.splitext(os.path.basename(caminho_arquivo))[0]
        identificador = self.track_usernames.get(os.path.basename(caminho_arquivo))
        if not identificador:
            identificador = (
                nome_base.split("-", 1)[1] if "-" in nome_base else nome_base
            )
        nome_real = self.NomesReais.get(identificador, identificador)
        if nome_real == identificador:
            print(
                f"Aviso: nome real para {identificador} não encontrado "
                "na tabela de nomes reais — usando identificador"
            )
        return nome_real

    def listar_arquivos_participantes(self) -> Tuple[Optional[List[str]]]:
        """
        Exemplo de saida:
        [
            "C:/Users/Usuario/Downloads/Craig/craig_p2pFXooycpSJ_2026-6-18_23-9-41.aup_data/participante1.flac",
            "C:/Users/Usuario/Downloads/Craig/craig_p2pFXooycpSJ_2026-6-18_23-9-41.aup_data/participante2.flac",
            ...
        ]
        """
        arquivos_participantes = []
        if os.path.exists(self.diretorio_dados) and os.path.isdir(self.diretorio_dados):
            for entrada in os.scandir(self.diretorio_dados):
                if entrada.is_file() and (
                    entrada.name.lower().endswith(".flac")
                    or entrada.name.lower().endswith(".mp3")
                ):
                    arquivos_participantes.append(entrada.path)

        # maior primeiro para garantir que o narrador (com mais áudio) seja processado
        arquivos_participantes.sort(key=lambda f: os.path.getsize(f), reverse=True)
        return arquivos_participantes

    def deduzir_participantes(
        self,
    ) -> Tuple[str, List[str], List[str], List[str], str, str | None]:
        # Agrupa os arquivos de áudio por pessoa usando o nome real ou identificador.
        grupos: dict[str, list[str]] = defaultdict(list)

        for arquivo in self.arquivos_participantes:
            grupos[self.identificar_pessoa(arquivo)].append(arquivo)

        self.grupos_transcricao = dict(grupos)

        # Calcula a participação de cada pessoa com base no tamanho total dos arquivos de áudio.
        self.participacao_por_pessoa = {
            pessoa: sum(os.path.getsize(arquivo) for arquivo in arquivos)
            for pessoa, arquivos in grupos.items()
        }

        if not self.participacao_por_pessoa:
            raise RuntimeError("Nenhum canal de participante foi encontrado.")

        # O candidato inicial a narrador é quem possui mais áudio.
        narrador = self.identificar_pessoa(self.arquivos_participantes[0])

        # Se o candidato inicial não possui configuração de campanha,
        # procura o próximo participante com maior tempo que possua configuração.
        if narrador not in self.PersonagensDoJogo:
            print(
                f"Aviso: narrador {narrador} não encontrado na configuração do jogo; "
                "tentando o próximo participante com mais tempo"
            )

            for pessoa, _ in sorted(
                self.participacao_por_pessoa.items(),
                key=lambda item: item[1],
                reverse=True,
            ):
                if pessoa in self.PersonagensDoJogo:
                    narrador = pessoa
                    print(f"Narrador selecionado: {narrador}")
                    break
            else:
                raise RuntimeError(
                    "Nenhum narrador válido foi encontrado na configuração do jogo."
                )

        configuracao_jogo = self.PersonagensDoJogo.get(narrador, {})
        campanha = configuracao_jogo.get("Campanha", "Desconhecido")
        rss = configuracao_jogo.get("rss_key")

        # pega Todos os participantes, exceto o narrador atual.
        participacoes_jogadores = {
            pessoa: tamanho
            for pessoa, tamanho in self.participacao_por_pessoa.items()
            if pessoa != narrador
        }

        # ------------------------------------------------------------------
        # Testa a hipótese de que o segundo participante mais ativo seja
        # realmente o narrador e que o narrador atual seja um jogador.
        #
        # A comparação é feita corretamente entre:
        #
        # HIPÓTESE ORIGINAL
        #   narrador atual
        #   os demais como jogadores
        #
        # HIPÓTESE ALTERNATIVA
        #   segundo participante como narrador
        #   narrador atual como jogador
        #
        # Cada hipótese possui sua própria lista de participantes, para que
        # o narrador de uma hipótese não seja indevidamente removido da outra.
        # ------------------------------------------------------------------
        if participacoes_jogadores:
            jogador_mais_tempo, _ = max(
                participacoes_jogadores.items(),
                key=lambda item: item[1],
            )

            # Só vale testar a inversão se o participante mais ativo
            # não estiver configurado como personagem do narrador atual.
            if jogador_mais_tempo not in configuracao_jogo["players"]:
                print(
                    f"Aviso: participante com mais tempo {jogador_mais_tempo} "
                    f"não encontrado na configuração do jogo do narrador {narrador}"
                )

                configuracao_jogo_alternativa = self.PersonagensDoJogo.get(
                    jogador_mais_tempo,
                    {},
                )

                campanha_alternativa = configuracao_jogo_alternativa.get(
                    "Campanha",
                    "Desconhecido",
                )

                rss_alternativa = configuracao_jogo_alternativa.get("rss_key")

                # Participantes da hipótese ORIGINAL:
                # tudo, exceto o narrador atual.
                participantes_original = {
                    pessoa
                    for pessoa in self.participacao_por_pessoa
                    if pessoa != narrador
                }

                # Participantes da hipótese ALTERNATIVA:
                # tudo, exceto o candidato a novo narrador.
                participantes_alternativa = {
                    pessoa
                    for pessoa in self.participacao_por_pessoa
                    if pessoa != jogador_mais_tempo
                }

                participantes_identificados_original = sum(
                    1
                    for pessoa in participantes_original
                    if pessoa in configuracao_jogo["players"]
                )

                participantes_identificados_alternativa = sum(
                    1
                    for pessoa in participantes_alternativa
                    if pessoa in configuracao_jogo_alternativa.get("players", {})
                )

                print(
                    f"Hipótese original ({narrador} como narrador): "
                    f"{participantes_identificados_original} participante(s) identificado(s)"
                )

                print(
                    f"Hipótese alternativa ({jogador_mais_tempo} como narrador): "
                    f"{participantes_identificados_alternativa} participante(s) identificado(s)"
                )

                if (
                    participantes_identificados_alternativa
                    > participantes_identificados_original
                ):
                    print(
                        f"Troca de narrador e participante: "
                        f"{narrador} <-> {jogador_mais_tempo}"
                    )

                    narrador, jogador_mais_tempo = (
                        jogador_mais_tempo,
                        narrador,
                    )

                    configuracao_jogo = configuracao_jogo_alternativa
                    campanha = campanha_alternativa
                    rss = rss_alternativa

                    # IMPORTANTE:
                    # Reconstrói os jogadores usando o NOVO narrador.
                    participacoes_jogadores = {
                        pessoa: tamanho
                        for pessoa, tamanho in self.participacao_por_pessoa.items()
                        if pessoa != narrador
                    }

        media = (
            sum(participacoes_jogadores.values()) / len(participacoes_jogadores)
            if participacoes_jogadores
            else 0
        )

        limite_ouvinte = media / 5 if media else 0

        jogadores = []
        personagens = []
        ouvintes = []

        for pessoa, tamanho in sorted(
            participacoes_jogadores.items(),
            key=lambda item: item[1],
            reverse=True,
        ):
            if tamanho < limite_ouvinte:
                ouvintes.append(pessoa)
                continue

            jogadores.append(pessoa)

            personagem = configuracao_jogo["players"].get(pessoa, pessoa)

            if personagem == pessoa:
                print(
                    f"Aviso: personagem para {pessoa} não encontrado "
                    f"para o narrador {narrador} — usando nome real"
                )

            personagens.append(personagem)

        jogadores = list(dict.fromkeys(jogadores))
        personagens = list(dict.fromkeys(personagens))
        ouvintes = list(dict.fromkeys(ouvintes))

        print(
            f"Narrador: {narrador}, Campanha: {campanha}, "
            f"Personagens ({len(personagens)}): "
            f"{', '.join(personagens) if personagens else '(nenhum)'}"
        )

        if ouvintes:
            print(
                "Ouvintes transcritos, mas omitidos como participantes: "
                + ", ".join(ouvintes)
            )

        return (
            narrador,
            jogadores,
            personagens,
            ouvintes,
            campanha,
            rss,
        )

    @staticmethod
    def obter_duracao_audio(files: Optional[List[str]] = None) -> float:
        maior = 0

        for arquivo in files:
            resultado = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    arquivo,
                ],
                capture_output=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                text=True,
                check=True,
            )

            maior = max(maior, float(resultado.stdout))

        return maior

    @staticmethod
    def formatar_tempo(segundos: float) -> str:
        segundos = int(segundos)
        horas, resto = divmod(segundos, 3600)
        minutos, segundos = divmod(resto, 60)

        if horas:
            return f"{horas:02d}:{minutos:02d}:{segundos:02d}"

        return f"{minutos:02d}:{segundos:02d}"

    def ffmpeg(
        self,
        args: list[str],
        descricao: str,
        duracao: float,
    ):
        """
        Executa um comando FFmpeg com barra de progresso baseada em tempo.
        já embute o comando "ffmpeg -hide_banner -nostdin -loglevel error -progress pipe:1 -y" no início do comando.
        """
        comando = [
            "ffmpeg",
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-progress",
            "pipe:1",
            "-y",
        ]
        comando.extend(args)

        # Arquivo temporário evita bloquear quando o FFmpeg escreve muito no stderr.
        error_log = tempfile.TemporaryFile(
            mode="w+", encoding="utf-8", errors="replace"
        )
        processo = subprocess.Popen(
            comando,
            stdout=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            stderr=error_log,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

        emit(
            "progress",
            state="processing",
            label=descricao,
            processed=0,
            duration=duracao,
            percent=0,
        )
        barra = tqdm(
            disable=os.getenv("CRAIG_GUI_EVENTS") == "1",
            total=duracao,
            desc=f"{descricao} ({AudioManager.formatar_tempo(duracao)})",
            bar_format=("{l_bar}{bar}| {percentage:3.0f}% [{elapsed}<{remaining}]"),
        )

        ultimo = 0.0

        for linha in processo.stdout:
            linha = linha.strip()

            if linha.startswith(("out_time_us=", "out_time_ms=")):
                valor = linha.split("=", 1)[1]

                if valor == "N/A":
                    continue

                try:
                    micros = int(valor)
                except ValueError:
                    continue

                segundos = min(micros / 1_000_000, duracao)

                if segundos > ultimo:
                    barra.update(segundos - ultimo)
                    ultimo = segundos
                    emit(
                        "progress",
                        state="processing",
                        label=descricao,
                        processed=segundos,
                        duration=duracao,
                        percent=100 * segundos / duracao if duracao else 0,
                    )

        processo.wait()
        error_log.seek(0)
        stderr = error_log.read()
        error_log.close()
        processo.stdout.close()
        if processo.returncode == 0:
            barra.n = duracao
            barra.refresh()
        barra.close()
        emit(
            "progress",
            state="completed" if processo.returncode == 0 else "error",
            label=descricao,
            percent=100 if processo.returncode == 0 else 0,
        )

        if processo.returncode != 0:
            if stderr.strip():
                print(f"FFmpeg ({descricao}):\n{stderr.strip()}", flush=True)
            raise subprocess.CalledProcessError(
                processo.returncode,
                comando,
                stderr=stderr,
            )

    def mix(self):
        """
        Mistura os áudios individuais de cada participante em uma única faixa MP3.
        """
        self.audio_mix_path = os.path.join(
            self.pasta_extraida,
            f"{self.dataJogo} - S{self.session:02d}E{self.episode:02d} - {self.campanha}.mix.wav",
        )

        # skip se o mix ja existir
        if os.path.exists(self.audio_mix_path):
            print(f"Pulando {self.audio_mix_path} mix já existe")
            return self.audio_mix_path
        print(
            f"Ação: Mixando áudios de {len(self.arquivos_participantes)} participantes"
        )
        args = []

        for arquivo in self.arquivos_participantes:
            args.extend(["-i", arquivo])

        args.extend(
            [
                "-filter_complex",
                (
                    "".join(f"[{i}:a]" for i in range(len(self.arquivos_participantes)))
                    + f"amix=inputs={len(self.arquivos_participantes)}:normalize=1[mix]"
                ),
                "-map",
                "[mix]",
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                self.audio_mix_path,
            ]
        )

        self.ffmpeg(
            args,
            "Mixando",
            duracao=AudioManager.obter_duracao_audio(self.arquivos_participantes),
        )

        return self.audio_mix_path

    def build(self):
        """
        Aplica compressor, equalização e remoção de silêncio para gerar o produto final otimizado.
        """
        # skip se o arquivo final ja existir
        self.audio_path = os.path.join(
            self.pasta_extraida,
            f"{self.dataJogo} - S{self.session:02d}E{self.episode:02d} - {self.campanha}.mp3",
        )

        timeline_path = self.audio_path + ".timeline.json"
        if os.path.exists(self.audio_path):
            if not os.path.isfile(timeline_path):
                raise RuntimeError(
                    "Áudio final sem mapa de edição: mova o MP3 antigo para um backup e processe novamente para sincronizar legendas."
                )
            self.edit_timeline = json.loads(
                Path(timeline_path).read_text(encoding="utf-8")
            )
            print(f"Pulando {self.audio_path} mp3 já existe")
            return self.audio_path

        # pega ano do nome da pasta_extraida ex: craig_p2pFXooycpSJ_2026-6-18_23-9-41.aup
        artistas = "/".join(self.personagens)

        print(
            "Ação: Gerando áudio final com edição de pausas, compressor e normalização"
        )

        settings = get_config()["audio"]
        duration = self.obter_duracao_audio([self.audio_mix_path])
        edited_source, self.edit_timeline = edit_pauses(
            self.audio_mix_path, duration, settings, self.ffmpeg
        )
        cadeia_filtros = (
            f"acompressor=threshold={settings['compressor_threshold_db']}dB:ratio={settings['compressor_ratio']}:"
            f"attack={settings['compressor_attack_ms']}:release={settings['compressor_release_ms']},"
            f"loudnorm=I={settings['loudness_lufs']}:LRA={settings['loudness_range']}:TP={settings['true_peak_db']}"
        )
        publication = get_config()["publication"]

        cover_path = self.baixar_cover_se_existir()

        args = ["-i", str(edited_source)]

        if cover_path:
            args.extend(["-i", cover_path])

        args.extend(
            [
                "-af",
                cadeia_filtros,
            ]
        )

        if cover_path:
            args.extend(
                [
                    "-map",
                    "0:a",
                    "-map",
                    "1:v",
                ]
            )

        args.extend(
            [
                "-c:a",
                "libmp3lame",
                "-q:a",
                "2",
            ]
        )

        if cover_path:
            args.extend(
                [
                    "-c:v",
                    "mjpeg",
                    "-id3v2_version",
                    "3",
                    "-disposition:v",
                    "attached_pic",
                    "-metadata:s:v",
                    "title=Cover",
                    "-metadata:s:v",
                    "comment=Cover (front)",
                ]
            )

        args.extend(
            [
                "-metadata",
                f"title={self.campanha}",
                "-metadata",
                f"track={self.episode}",
                "-metadata",
                f"discnumber={self.session}",
                "-metadata",
                f"artist={artistas}",
                "-metadata",
                f"album=S{self.session:02d} {self.campanha}",
                "-metadata",
                f"albumartist={self.campanha}",
                "-metadata",
                f"genre={publication['genre']}",
                "-metadata",
                f"date={self.dataJogo}",
                "-metadata",
                f"year={self.ano}",
                "-metadata",
                f"composer={publication['brand']}",
                "-metadata",
                f"encoded_by={publication['website']}",
                "-metadata",
                f"copyright={publication['copyright']} {self.ano}",
                "-metadata",
                f"language={publication['language']}",
                "-metadata",
                "publisher=TravelRPG",
                "-metadata",
                f"organization={publication['brand']}",
                "-metadata",
                f"comment={publication['comment']}",
                self.audio_path,
            ]
        )

        self.ffmpeg(
            args,
            "Compilando",
            duracao=AudioManager.obter_duracao_audio([edited_source]),
        )

        save_timeline(timeline_path, self.edit_timeline)
        if edited_source != self.audio_mix_path:
            Path(edited_source).unlink(missing_ok=True)
        if cover_path:
            try:
                os.remove(cover_path)
            except Exception as e:
                print(
                    f"Aviso: não foi possível limpar arquivos temporários da capa: {e}"
                )

        print(f"Ação: Arquivo final gerado com sucesso em {self.audio_path}")

        return self.audio_path

    def renomear_arquivos(self, nome_sessao: str) -> dict[str, str]:
        titulo_sessao = self.nome_seguro(nome_sessao)
        base = (
            f"{self.dataJogo} - "
            f"S{self.session:02d}E{self.episode:02d} - "
            f"{titulo_sessao}"
        )
        novos_caminhos = {}

        for atributo, sufixo in (
            ("audio_mix_path", ".mix.wav"),
            ("audio_path", ".mp3"),
        ):
            caminho_atual = getattr(self, atributo)
            if not caminho_atual:
                continue

            origem = Path(caminho_atual)
            destino = origem.with_name(base + sufixo)
            if origem != destino:
                if destino.exists():
                    raise FileExistsError(
                        f"Não é possível renomear; destino já existe: {destino}"
                    )
                timeline = Path(str(origem) + ".timeline.json")
                target_timeline = Path(str(destino) + ".timeline.json")
                if atributo == "audio_path" and timeline.exists():
                    if target_timeline.exists():
                        raise FileExistsError(
                            f"Mapa de edição já existe: {target_timeline}"
                        )
                    timeline.rename(target_timeline)
                origem.rename(destino)
            setattr(self, atributo, str(destino))
            novos_caminhos[atributo] = str(destino)

        return novos_caminhos

    def alterar_title(self, nome_sessao: str) -> None:
        if not self.audio_path:
            raise RuntimeError("O MP3 principal ainda não foi gerado.")

        origem = Path(self.audio_path)
        file_temp = origem.with_name(origem.stem + ".title.tmp.mp3")
        args = [
            "-i",
            str(origem),
            "-map",
            "0",
            "-c",
            "copy",
            "-metadata",
            f"title={nome_sessao}",
            str(file_temp),
        ]

        try:
            self.ffmpeg(
                args,
                descricao="Atualizando metadata",
                duracao=AudioManager.obter_duracao_audio([str(origem)]),
            )
            os.replace(file_temp, origem)
        finally:
            if file_temp.exists():
                file_temp.unlink()

        print(f"Tag title do MP3 alterada para: {nome_sessao}")

    def baixar_cover_se_existir(self) -> str | None:
        if not self.rss:
            return None

        pasta_rss = self.rss.rsplit("/", 1)[0]
        chave_cover = f"{pasta_rss}/cover.jpg"

        dados = self.object_storage_manager.getObjectIfExists(chave_cover)
        if not dados:
            print(f"Cover não encontrado em S3/R2: {chave_cover}")
            return None

        caminho_cover = f"{self.name}.cover.jpg"
        with open(caminho_cover, "wb") as f:
            f.write(dados)

        print(f"Cover encontrado e baixado: {chave_cover}")
        return caminho_cover

    def obter_temporada_episodio(self) -> tuple[int, int]:
        """
        Determina a temporada e o próximo episódio.

        Ordem:
        1. Tenta obter pelo RSS.
        2. Se o RSS estiver ausente, inválido ou não possuir episódios
        reconhecíveis, tenta pelos arquivos existentes no Object Storage.
        """

        if self.rss is None:
            raise RuntimeError("RSS não configurado para esta campanha.")

        try:
            xml_content = self.object_storage_manager.getObject(self.rss)
            root = ET.fromstring(xml_content)

            items = root.findall(".//item")

            temporada_max = 0
            episodio_max = 0

            for item in items:
                season_elem = item.find(
                    ".//{http://www.itunes.com/dtds/podcast-1.0.dtd}season"
                )

                episode_elem = item.find(
                    ".//{http://www.itunes.com/dtds/podcast-1.0.dtd}episode"
                )

                if season_elem is None or episode_elem is None:
                    continue

                try:
                    temporada = int(season_elem.text)
                    episodio = int(episode_elem.text)
                except (ValueError, TypeError):
                    continue

                if temporada > temporada_max or (
                    temporada == temporada_max and episodio > episodio_max
                ):
                    temporada_max = temporada
                    episodio_max = episodio

            if temporada_max > 0 and episodio_max > 0:
                proximo_episodio = episodio_max + 1

                print(
                    f"Último episódio encontrado no RSS: "
                    f"S{temporada_max:02d}E{episodio_max:02d}"
                )

                print(f"Próximo episódio: S{temporada_max:02d}E{proximo_episodio:02d}")

                return temporada_max, proximo_episodio

            print(
                "Aviso: nenhum episódio válido encontrado no RSS. "
                "Tentando Object Storage."
            )

        except Exception as erro:
            print(
                f"Aviso: não foi possível determinar temporada/episódio "
                f"pelo RSS: {erro}"
            )

            print("Tentando determinar pelos arquivos do Object Storage.")

        return self.obter_temporada_episodio_storage()

    def obter_temporada_episodio_storage(self) -> tuple[int, int]:
        """
        Determina o próximo episódio pelos nomes dos arquivos de áudio
        existentes no Object Storage.
        """

        if not self.rss:
            raise RuntimeError(
                "Não há RSS configurado para determinar a pasta da campanha."
            )

        pasta_rss = self.rss.rsplit("/", 1)[0]

        print(
            f"Tentando determinar temporada/episódio pelos arquivos "
            f"do storage: {pasta_rss}"
        )

        objetos = self.object_storage_manager.list_objects(f"{pasta_rss}/")

        temporada_max = 0
        episodio_max = 0

        padrao = re.compile(
            r"\bS(\d+)E(\d+)\b",
            re.IGNORECASE,
        )

        for objeto in objetos:
            if isinstance(objeto, dict):
                chave = objeto.get("Key", "")
            else:
                chave = str(objeto)

            if not chave.lower().endswith((".mp3", ".m4a")):
                continue

            nome = os.path.basename(chave)

            match = padrao.search(nome)

            if not match:
                continue

            temporada = int(match.group(1))
            episodio = int(match.group(2))

            if temporada == 0 or episodio == 0:
                continue

            if temporada > temporada_max or (
                temporada == temporada_max and episodio > episodio_max
            ):
                temporada_max = temporada
                episodio_max = episodio

        if temporada_max == 0 or episodio_max == 0:
            raise RuntimeError(
                f"Não foi possível determinar temporada/episódio "
                f"pelos arquivos em {pasta_rss}."
            )

        proximo_episodio = episodio_max + 1

        print(
            f"Último episódio encontrado no storage: "
            f"S{temporada_max:02d}E{episodio_max:02d}"
        )

        print(f"Próximo episódio: S{temporada_max:02d}E{proximo_episodio:02d}")

        return temporada_max, proximo_episodio
