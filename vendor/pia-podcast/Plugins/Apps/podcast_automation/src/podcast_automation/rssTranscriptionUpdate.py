from .settings import option
from src.user_paths import user_path
from .settings import get_config, env_bool
from .feedCache import FeedCache, manifest, object_signature, signature
import html
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from email.utils import format_datetime
from xml.sax.saxutils import escape as escape_xml

from .objectStorageManager import ObjectStorageManager


class RssTranscriptionUpdater:
    """
    Atualiza os arquivos rss.xml e transcripts.html das campanhas
    armazenadas no Object Storage.

    Substitui a antiga Lambda em index.js.
    """

    def __init__(self, obj_storage: ObjectStorageManager):
        self.obj_storage = obj_storage

        self.owner_email = option("OWNER_EMAIL", "")
        self.owner_name = get_config()["publication"]["brand"]

        self.transcripts_file = option(
            "TRANSCRIPTS_FILE",
            "transcripts.html",
        )
        self.language = get_config()["publication"]["language"]
        identity = getattr(obj_storage, "identity", None)
        self.cache = FeedCache(
            identity
            if isinstance(identity, dict)
            else {"adapter": type(obj_storage).__name__}
        )

    # ============================================================
    # API PÚBLICA
    # ============================================================
    def updateRssTranscriptionFiles(
        self,
        folder: str | None = None,
    ) -> dict:
        """
        Atualiza RSS e página de transcrições.

        Se folder for informado:
            atualiza apenas aquela campanha.

        Se folder for None:
            atualiza somente as campanhas referenciadas no config.json.
        """

        print("Iniciando atualização de RSS e transcrições")

        if folder:
            folders = [folder.rstrip("/")]
        else:
            folders = self.discover_podcast_folders()

        processados = []
        erros = []

        for pasta in folders:
            try:
                print("\n----------------------------------------")
                print(f"Atualizando campanha: {pasta}")
                print("----------------------------------------")

                details = self.configured_podcasts().get(pasta)
                if details is None:
                    print(f"Campanha não configurada. Pulando: {pasta}")
                    continue

                if details.get("closed") is True and env_bool("SKIP_CLOSED", True):
                    print(f"Podcast fechado. Pulando: {pasta}")
                    continue

                resultado = self.rebuild_podcast_feed(pasta)

                processados.append(
                    {
                        "folder": pasta,
                        **resultado,
                    }
                )

            except Exception as erro:
                print(f"Erro ao processar {pasta}: {type(erro).__name__}: {erro}")

                erros.append(
                    {
                        "folder": pasta,
                        "erro": str(erro),
                    }
                )

        resultado = {
            "success": not erros,
            "foldersProcessed": len(processados),
            "folders": processados,
            "errors": erros,
        }

        print(f"\nAtualização concluída. Campanhas processadas: {len(processados)}")

        return resultado

    # ============================================================
    # DESCOBERTA DE CAMPANHAS
    # ============================================================
    def discover_podcast_folders(self) -> list[str]:
        return sorted(self.configured_podcasts())

    @staticmethod
    def configured_podcasts() -> dict[str, dict]:
        """Allowlist local: não descobre podcasts a partir do bucket."""
        return {
            details["rss_key"].rsplit("/", 1)[0]: {
                **details,
                "title": details.get("title") or details["Campanha"],
            }
            for details in get_config()["campaign_details"].values()
        }

    @staticmethod
    def extract_folder(key: str) -> str | None:
        if not key:
            return None

        cleaned = key.rstrip("/")

        if "/" not in cleaned:
            return None

        return cleaned.rsplit("/", 1)[0]

    # ============================================================
    # PROCESSAMENTO DA CAMPANHA
    # ============================================================
    def rebuild_podcast_feed(self, folder: str) -> dict:
        # Mantém a proteção mesmo quando o método é chamado diretamente.
        folder = folder.rstrip("/")
        details = self.configured_podcasts().get(folder)
        if details is None or (
            details.get("closed", False) and env_bool("SKIP_CLOSED", True)
        ):
            return {"rss_updated": False, "transcripts_updated": False}
        print(f"Verificando RSS e transcrições: {folder}")
        self._duration_failed = False
        objects = self.folder_objects(folder)
        config_signature = signature(
            {
                "reader_version": 2,
                "campaigns": self.configured_podcasts(),
                "details": details,
                "publication": get_config()["publication"],
                "owner_email": self.owner_email,
                "owner_name": self.owner_name,
                "language": self.language,
                "transcripts_file": self.transcripts_file,
            }
        )
        remote_signature = manifest(objects)
        previous = self.cache.data["folders"].get(folder)
        if (
            not env_bool("FEED_FORCE_REBUILD")
            and remote_signature is not None
            and previous == {"config": config_signature, "remote": remote_signature}
        ):
            print(f"Sem alterações na configuração ou no bucket. Pulando: {folder}")
            return {"rss_updated": False, "transcripts_updated": False}

        cover = self.find_cover(objects)

        rss_updated = False
        transcripts_updated = False

        # --------------------------------------------------------
        # RSS
        # --------------------------------------------------------

        audio_files = sorted(
            [
                objeto
                for objeto in objects
                if objeto.get("Key", "").lower().endswith((".mp3", ".m4a"))
            ],
            key=lambda objeto: objeto["Key"],
        )

        if audio_files:
            image_map = self.build_image_map(objects)

            episodes = [
                self.build_episode(
                    arquivo,
                    image_map,
                    cover,
                    details,
                )
                for arquivo in audio_files
            ]

            xml = self.build_feed_xml(
                episodes,
                cover,
                details,
            )

            rss_key = f"{folder}/rss.xml"

            existing_xml = self.obj_storage.getObjectIfExists(rss_key)
            if existing_xml is not None:
                existing_xml = existing_xml.decode("utf-8")

            if existing_xml != xml:
                self.obj_storage.putObject(
                    rss_key,
                    xml.encode("utf-8"),
                    content_type="application/rss+xml",
                )

                rss_updated = True

                print(f"RSS atualizado: {rss_key}")
                print(f"RSS público: {self.obj_storage.public_url(rss_key)}")
            else:
                print("RSS gerado é idêntico; upload dispensado.")

        else:
            print("Nenhum arquivo de áudio encontrado.")

        # --------------------------------------------------------
        # TRANSCRIÇÕES
        # --------------------------------------------------------

        roteiro_files = sorted(
            [
                objeto
                for objeto in objects
                if objeto.get("Key", "").lower().endswith(".txt")
            ],
            key=lambda objeto: objeto["Key"],
        )

        if roteiro_files:
            episodes = [self.build_transcription(arquivo) for arquivo in roteiro_files]

            pagina = self.build_feed_html(
                episodes,
                cover,
                details,
            )

            transcripts_key = f"{folder}/{self.transcripts_file}"

            existing_html = self.obj_storage.getObjectIfExists(transcripts_key)
            if existing_html is not None:
                existing_html = existing_html.decode("utf-8")

            if existing_html != pagina:
                self.obj_storage.putObject(
                    transcripts_key,
                    pagina.encode("utf-8"),
                    content_type="text/html; charset=utf-8",
                )

                transcripts_updated = True

                print(f"Página de transcrições atualizada: {transcripts_key}")

                print(f"URL pública: {self.obj_storage.public_url(transcripts_key)}")

            else:
                print("Página de transcrições idêntica; upload dispensado.")

        else:
            print("Nenhum arquivo de roteiro encontrado.")

        # Obtém as versões dos derivados após os uploads e só confirma o cache
        # se as fontes continuarem iguais (não esconde alterações concorrentes).
        after = self.folder_objects(folder)
        outputs = {f"{folder}/rss.xml", f"{folder}/{self.transcripts_file}"}
        before_inputs = manifest([obj for obj in objects if obj["Key"] not in outputs])
        after_inputs = manifest([obj for obj in after if obj["Key"] not in outputs])
        after_signature = manifest(after)
        output_keys = {obj["Key"] for obj in after}
        expected = ({f"{folder}/rss.xml"} if audio_files else set()) | (
            {f"{folder}/{self.transcripts_file}"} if roteiro_files else set()
        )
        if (
            not self._duration_failed
            and before_inputs is not None
            and before_inputs == after_inputs
            and after_signature is not None
            and expected <= output_keys
        ):
            self.cache.data["folders"][folder] = {
                "config": config_signature,
                "remote": after_signature,
            }
        else:
            self.cache.data["folders"].pop(folder, None)
        self.cache.save()

        return {
            "rss_updated": rss_updated,
            "transcripts_updated": transcripts_updated,
        }

    def folder_objects(self, folder):
        return [
            obj
            for obj in self.obj_storage.list_objects(f"{folder}/")
            if self.extract_folder(obj.get("Key", "")) == folder
        ]

    def cached_audio_duration(self, file, url):
        version = object_signature(file)
        key = signature([url, version])
        cached = self.cache.data["durations"].get(key)
        if (
            version is not None
            and isinstance(cached, int)
            and not isinstance(cached, bool)
            and cached >= 0
        ):
            return cached
        duration = self.get_audio_duration(url)
        if duration is None:
            self._duration_failed = True
        if (
            version is not None
            and isinstance(duration, int)
            and not isinstance(duration, bool)
            and duration >= 0
        ):
            self.cache.data["durations"][key] = duration
        return duration

    # ============================================================
    # CAPAS / IMAGENS
    # ============================================================
    def find_cover(
        self,
        objects: list[dict],
    ) -> str | None:
        cover_names = {
            "cover.jpg",
            "cover.png",
        }

        for objeto in objects:
            key = objeto.get("Key")

            if not key:
                continue

            arquivo = key.rsplit("/", 1)[-1].lower()

            if arquivo in cover_names:
                return self.obj_storage.public_url(key)

        return None

    @staticmethod
    def build_image_map(
        objects: list[dict],
    ) -> dict[str, str]:
        image_map = {}

        for objeto in objects:
            key = objeto.get("Key")

            if not key:
                continue

            nome = key.rsplit("/", 1)[-1].lower()

            if nome.endswith((".jpg", ".jpeg", ".png")):
                image_map[nome] = key

        return image_map

    # ============================================================
    # EPISÓDIOS RSS
    # ============================================================
    def build_episode(
        self,
        file: dict,
        image_map: dict[str, str],
        cover: str | None,
        details: dict,
    ) -> dict:
        key = file["Key"]
        file_name = key.rsplit("/", 1)[-1]

        without_ext = re.sub(
            r"\.(mp3|m4a)$",
            "",
            file_name,
            flags=re.IGNORECASE,
        )

        pub_date = file.get("LastModified")

        if pub_date is None:
            pub_date = datetime.now(timezone.utc)

        title = without_ext

        match = re.match(
            r"^\s*(\d{4})-(\d{2})-(\d{2})" r"\s*-\s*(.+)$",
            without_ext,
        )

        if match:
            year = int(match.group(1))
            month = int(match.group(2))
            day = int(match.group(3))

            title = match.group(4).strip()

            pub_date = datetime(
                year,
                month,
                day,
                23,
                0,
                0,
                tzinfo=timezone.utc,
            )

        # --------------------------------------------------------
        # resumo.json correspondente
        # --------------------------------------------------------

        resumo_key = re.sub(
            r"\.(mp3|m4a)$",
            ".resumo.json",
            key,
            flags=re.IGNORECASE,
        )

        resumo_data = {}

        conteudo_resumo = self.obj_storage.getObjectIfExists(resumo_key)

        if conteudo_resumo:
            try:
                resumo_data = json.loads(conteudo_resumo.decode("utf-8"))

                if not isinstance(
                    resumo_data,
                    dict,
                ):
                    resumo_data = {}

            except (
                json.JSONDecodeError,
                UnicodeDecodeError,
            ):
                resumo_data = {}

        audio_url = self.obj_storage.public_url(key)
        duration = self.cached_audio_duration(file, audio_url)

        episode_number = None
        season_number = None

        ep_match = re.search(
            r"S(\d{1,3})E(\d{1,3})",
            title,
            flags=re.IGNORECASE,
        )

        if ep_match:
            season_number = int(ep_match.group(1))
            episode_number = int(ep_match.group(2))

        is_resumo = bool(
            re.search(
                r" - resumo\.(m4a|mp3)$",
                file_name,
                flags=re.IGNORECASE,
            )
        )

        subtitle = without_ext

        podcast_link = details.get("link") or ""

        summary_lines = []

        personagens = resumo_data.get("Personagens")

        if personagens:
            if isinstance(personagens, list):
                personagens_str = ", ".join(str(p) for p in personagens)
            else:
                personagens_str = str(personagens)

            summary_lines.append(f"🎭 Personagens: {personagens_str}")

        summary_lines.append(f"🌟 Podcast: {podcast_link}")

        resumo_rapido = resumo_data.get("resumo_rapido")

        if resumo_rapido:
            summary_lines.append(f"📝 Resumo: {resumo_rapido}")

        summary_lines.append("Generated By: TravelRPG")

        summary = "\n\t\n\t".join(summary_lines)

        # --------------------------------------------------------
        # content:encoded
        # --------------------------------------------------------

        content_html = ""

        if personagens:
            if isinstance(personagens, list):
                personagens_str = ", ".join(str(p) for p in personagens)
            else:
                personagens_str = str(personagens)

            content_html += (
                "<p><strong>🎭 Personagens:</strong> "
                f"{html.escape(personagens_str)}</p>"
            )

        content_html += f"🌟 Podcast: {html.escape(podcast_link)}<br/>"

        if resumo_rapido:
            content_html += (
                f"<p><strong>📝 Resumo:</strong> {html.escape(str(resumo_rapido))}</p>"
            )

        content_html += html.escape("Generated By: TravelRPG")

        # --------------------------------------------------------
        # imagem específica do episódio
        # --------------------------------------------------------

        base_name = file_name.lower()

        jpg_name = re.sub(
            r"\.(mp3|m4a)$",
            ".jpg",
            base_name,
            flags=re.IGNORECASE,
        )

        episode_image = None

        if jpg_name in image_map:
            episode_image = self.obj_storage.public_url(image_map[jpg_name])
        elif cover:
            episode_image = cover

        episode_type = (
            "bonus"
            if re.search(
                r" - bonus$",
                without_ext,
                flags=re.IGNORECASE,
            )
            else "full"
        )

        mime_type = "audio/mp4" if key.lower().endswith(".m4a") else "audio/mpeg"

        return {
            "title": title,
            "description": summary,
            "guid": audio_url,
            "url": audio_url,
            "date": pub_date,
            "enclosure": {
                "url": audio_url,
                "size": file.get("Size", 0),
                "type": mime_type,
            },
            "itunes": {
                "episodeType": episode_type,
                "title": title,
                "episode": episode_number,
                "season": season_number,
                "author": (details.get("author") or details.get("title")),
                "subtitle": subtitle,
                "summary": summary,
                "content": content_html,
                "image": episode_image,
                # Mantém o comportamento do JS:
                # Size é usado como fallback.
                "duration": duration,
                "explicit": ("yes" if details.get("explicit") else "no"),
            },
            "meta": {
                "isResumo": is_resumo,
            },
        }

    # ============================================================
    # TRANSCRIÇÕES
    # ============================================================
    def build_transcription(
        self,
        file: dict,
    ) -> dict:
        roteiro = self.obj_storage.getObject(file["Key"]).decode("utf-8")

        file_name = file["Key"].rsplit("/", 1)[-1]

        title = re.sub(
            r"\.txt$",
            "",
            file_name,
            flags=re.IGNORECASE,
        )

        return {
            "title": title,
            "content": roteiro,
        }

    # ============================================================
    # RSS XML
    # ============================================================
    def build_feed_xml(
        self,
        episodes: list[dict],
        cover: str | None,
        details: dict,
    ) -> str:
        title = str(details.get("title") or "")
        description = str(details.get("description") or f"Podcast de {title}")
        link = str(details.get("link") or "")
        copyright_text = str(get_config()["publication"]["copyright"])
        explicit = "yes" if details.get("explicit") else "no"
        xml = (
            '<?xml version="1.0" '
            'encoding="UTF-8"?>\n'
            '<rss version="2.0" '
            'xmlns:itunes="http://www.itunes.com/'
            'dtds/podcast-1.0.dtd" '
            'xmlns:content="http://purl.org/rss/'
            '1.0/modules/content/" '
            'xmlns:podcast="https://podcastindex.org/'
            'namespace/1.0">\n'
            "\t<channel>\n"
            f"\t\t<title>{self.xml(title)}</title>\n"
            f"\t\t<link>{self.xml(link)}</link>\n"
            f"\t\t<language>{self.xml(self.language)}</language>\n"
            f"\t\t<copyright>{self.xml(copyright_text)}</copyright>\n"
            f"\t\t<itunes:subtitle>{self.xml(title)}</itunes:subtitle>\n"
            f"\t\t<itunes:author>{self.xml(details.get('author') or title)}</itunes:author>\n"
            f"\t\t<itunes:summary>{self.xml(description)}</itunes:summary>\n"
            f"\t\t<description>{self.xml(description)}</description>\n"
            "\t\t<itunes:type>serial</itunes:type>\n"
            "\t\t<podcast:locked>no</podcast:locked>\n"
            "\t\t<itunes:owner>\n"
            f"\t\t\t<itunes:name>{self.xml(self.owner_name)}</itunes:name>\n"
            f"\t\t\t<itunes:email>{self.xml(self.owner_email)}</itunes:email>\n"
            "\t\t</itunes:owner>\n"
            f'\t\t<itunes:category text="Fiction"/>\n'
            f"\t\t<itunes:explicit>{self.xml(explicit)}</itunes:explicit>\n"
            f"\t\t<generator>TravelRPG</generator>\n"
        )

        if cover:
            xml += (
                "\t\t<image>\n"
                f"\t\t\t<url>{self.xml(cover)}</url>\n"
                f"\t\t\t<title>{self.xml(title)}</title>\n"
                f"\t\t\t<link>{self.xml(link)}</link>\n"
                "\t\t</image>\n"
                f'\t\t<itunes:image href="{self.xml(cover)}" />\n'
            )

        for ep in episodes:
            xml += "\t\t<item>\n"

            xml += f"\t\t\t<title><![CDATA[{self.cdata(ep['title'])}]]></title>\n"

            xml += (
                f"\t\t\t<description><![CDATA["
                f"{self.cdata(ep['description'])}"
                f"]]></description>\n"
            )

            xml += f'\t\t\t<guid isPermaLink="false">{self.xml(ep["guid"])}</guid>\n'

            xml += f"\t\t\t<link>{self.xml(get_config()['publication']['website'])}</link>\n"

            xml += f"\t\t\t<pubDate>{self.format_rfc2822(ep['date'])}</pubDate>\n"

            enclosure = ep["enclosure"]

            xml += (
                "\t\t\t<enclosure "
                f'url="{self.xml(enclosure["url"])}" '
                f'length="{enclosure.get("size", 0)}" '
                f'type="{self.xml(enclosure["type"])}" '
                "/>\n"
            )

            itunes = ep.get("itunes") or {}

            xml += (
                "\t\t\t<itunes:episodeType>"
                f"{self.xml(itunes.get('episodeType', 'full'))}"
                "</itunes:episodeType>\n"
            )

            if itunes.get("title"):
                xml += (
                    f"\t\t\t<itunes:title>{self.xml(itunes['title'])}</itunes:title>\n"
                )

            if itunes.get("episode") is not None:
                xml += f"\t\t\t<itunes:episode>{itunes['episode']}</itunes:episode>\n"

            if itunes.get("season") is not None:
                xml += f"\t\t\t<itunes:season>{itunes['season']}</itunes:season>\n"

            if itunes.get("author"):
                xml += (
                    "\t\t\t<itunes:author>"
                    f"{self.xml(itunes['author'])}"
                    "</itunes:author>\n"
                )

            if itunes.get("subtitle"):
                xml += (
                    "\t\t\t<itunes:subtitle>"
                    f"{self.xml(itunes['subtitle'])}"
                    "</itunes:subtitle>\n"
                )

            if itunes.get("summary"):
                xml += (
                    "\t\t\t<itunes:summary><![CDATA["
                    f"{self.cdata(itunes['summary'])}"
                    "]]></itunes:summary>\n"
                )

            if itunes.get("content"):
                xml += (
                    "\t\t\t<content:encoded><![CDATA["
                    f"{self.cdata(itunes['content'])}"
                    "]]></content:encoded>\n"
                )

            if itunes.get("image"):
                xml += f'\t\t\t<itunes:image href="{self.xml(itunes["image"])}"/>\n'

            if itunes.get("duration"):
                xml += (
                    "\t\t\t<itunes:duration>"
                    f"{self.xml(str(itunes['duration']))}"
                    "</itunes:duration>\n"
                )

            if itunes.get("explicit"):
                xml += (
                    "\t\t\t<itunes:explicit>"
                    f"{self.xml(itunes['explicit'])}"
                    "</itunes:explicit>\n"
                )

            xml += "\t\t</item>\n"

        xml += "\t</channel>\n"
        xml += "</rss>\n"

        return xml

    # ============================================================
    # HTML DAS TRANSCRIÇÕES
    # ============================================================
    def build_feed_html(
        self,
        episodes: list[dict],
        cover: str | None,
        details: dict,
    ) -> str:
        from podcast_automation.transcripts_page import render

        campaigns = [
            {
                "title": item.get("title") or item["Campanha"],
                "rss_key": item["rss_key"],
                "url": self.obj_storage.public_url(
                    folder + "/" + self.transcripts_file
                ),
            }
            for folder, item in self.configured_podcasts().items()
        ]
        return render(episodes, cover, details, campaigns)

    # ============================================================
    # UTILITÁRIOS
    # ============================================================
    @staticmethod
    def get_audio_duration(url: str) -> int | None:
        try:
            resultado = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    url,
                ],
                capture_output=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                text=True,
                check=True,
                timeout=60,
            )

            duracao = float(resultado.stdout.strip())

            if duracao <= 0:
                return None

            return round(duracao)

        except subprocess.CalledProcessError as erro:
            stderr = (erro.stderr or "").strip()

            print(
                f"Aviso: ffprobe falhou ao obter duração de {url}\n"
                f"Detalhes: {stderr or erro}"
            )
            return None

        except (
            subprocess.TimeoutExpired,
            ValueError,
            OSError,
        ) as erro:
            print(f"Aviso: não foi possível obter duração de {url}: {erro}")
            return None

    @staticmethod
    def xml(valor) -> str:
        if valor is None:
            return ""

        return escape_xml(
            str(valor),
            {
                '"': "&quot;",
                "'": "&apos;",
            },
        )

    @staticmethod
    def cdata(valor) -> str:
        """
        Prepara texto para uso seguro dentro de CDATA.
        Remove caracteres proibidos pelo XML 1.0 e impede
        encerramento acidental da seção CDATA.
        """

        if valor is None:
            return ""

        texto = str(valor)

        texto = re.sub(
            r"[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]",
            "",
            texto,
        )

        return texto.replace(
            "]]>",
            "]]]]><![CDATA[>",
        )

    @staticmethod
    def format_rfc2822(
        data: datetime,
    ) -> str:
        if data.tzinfo is None:
            data = data.replace(tzinfo=timezone.utc)

        return format_datetime(
            data.astimezone(timezone.utc),
            usegmt=True,
        )
