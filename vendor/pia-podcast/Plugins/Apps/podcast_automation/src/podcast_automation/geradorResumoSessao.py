from .settings import get_config
from .llm import PiaClient, sanitize_error_message
import json
import os
import re
from pathlib import Path
from typing import Any
import xml.etree.ElementTree as ET
from .objectStorageManager import ObjectStorageManager


class GeradorResumoSessao:
    """
    Gera um resumo estruturado de uma sessão de RPG usando a API da PIA.
    link do projeto: https://github.com/oouo-diogo-perdigao/pia

    Entrada:
        roteiro_path: arquivo de texto produzido pelo TranscritorWhisper.

    Saidas:
        <roteiro>.resumo.json
    """

    CAMPOS_OBRIGATORIOS = (
        "nome_sessao",
        "resumo_rapido",
        "resumo_completo",
    )

    INICIO_CABECALHO = "<!-- INICIO_RESUMO_SESSAO -->"
    FIM_CABECALHO = "<!-- FIM_RESUMO_SESSAO -->"

    def __init__(
        self,
        campanha: str,
        narrador: str,
        personagens: list[str],
        jogadores: list[str],
        ouvintes: list[str],
        roteiro_path: str,
        obj_storage: ObjectStorageManager,
        rss_key: str | None = None,
        max_tentativas: int = 6,
    ):
        self.campanha = str(campanha or "").strip() or "Nao informado"
        self.narrador = str(narrador or "").strip() or "Nao informado"

        self.personagens = [
            str(j).strip() for j in (personagens or []) if str(j).strip()
        ]
        self.personagens = (
            ", ".join(self.personagens) if self.personagens else "Nao informados"
        )

        self.jogadores = [str(j).strip() for j in (jogadores or []) if str(j).strip()]
        self.jogadores = (
            ", ".join(self.jogadores) if self.jogadores else "Nao informados"
        )

        self.ouvintes = [str(j).strip() for j in (ouvintes or []) if str(j).strip()]
        self.ouvintes = ", ".join(self.ouvintes) if self.ouvintes else "Nao informados"

        self.roteiro_path = str(roteiro_path)

        self.obj_storage = obj_storage
        self.rss_key = str(rss_key).strip() if rss_key else None

        self.max_tentativas = max(1, int(max_tentativas))

        caminho_base = os.path.splitext(self.roteiro_path)[0]
        self.resumo_json_path = caminho_base + ".resumo.json"
        self.resumo_path = self.resumo_json_path

        self.llm_provider, self.llm_model = self._ler_modelo_configurado()
        self.client = PiaClient(
            llm_provider=self.llm_provider,
            llm_model=self.llm_model,
        )

    @staticmethod
    def _ler_modelo_configurado() -> tuple[str, str]:
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

    def carregar_nomes_sessoes_anteriores(self) -> list[str]:
        """
        Obtém o rss.xml diretamente do Object Storage e retorna os nomes
        das sessões já publicadas, removendo prefixos como:

            S01E01 - Nome da Sessão
            S02E14 - Outro Nome

        Retorna [] caso não exista RSS ou nenhum episódio seja encontrado.
        """

        if not self.rss_key:
            print("RSS não informado; nenhum nome anterior será usado.")
            return []

        try:
            conteudo_rss = self.obj_storage.getObjectIfExists(self.rss_key)

            if conteudo_rss is None:
                print(f"RSS não encontrado no storage: {self.rss_key}")
                return []

        except Exception as erro:
            print(f"Não foi possível obter o RSS do storage ({self.rss_key}): {erro}")
            return []

        if not conteudo_rss:
            print(f"RSS vazio ou não encontrado no storage: {self.rss_key}")
            return []

        try:
            raiz = ET.fromstring(conteudo_rss)
        except ET.ParseError as erro:
            print(f"RSS inválido no storage ({self.rss_key}): {erro}")
            return []

        nomes: list[str] = []

        for item in raiz.findall("./channel/item"):
            titulo_elemento = item.find("title")

            if titulo_elemento is None or not titulo_elemento.text:
                continue

            titulo = titulo_elemento.text.strip()

            nome = re.sub(
                r"^\s*S\d+\s*E\d+\s*[-–—:]\s*",
                "",
                titulo,
                flags=re.IGNORECASE,
            ).strip()

            if nome:
                nomes.append(nome)

        nomes = list(dict.fromkeys(nomes))

        print(f"Nomes de sessões anteriores carregados do RSS: {len(nomes)}")

        return nomes

    def carregar_roteiro(self) -> str:
        caminho = Path(self.roteiro_path)

        if not caminho.is_file():
            raise FileNotFoundError(
                f"Arquivo de roteiro nao encontrado: {self.roteiro_path}"
            )

        roteiro = caminho.read_text(encoding="utf-8").strip()
        if not roteiro:
            raise ValueError(f"O arquivo de roteiro esta vazio: {self.roteiro_path}")

        return roteiro

    def montar_prompt(self, roteiro: str) -> str:
        sessoes = self.carregar_nomes_sessoes_anteriores()

        print(sessoes)

        if sessoes:
            lista_sessoes = "\n".join(f"- {nome}" for nome in sessoes)
        else:
            lista_sessoes = "(nenhuma sessão anterior encontrada)"

        return f"""Voce e um redator especializado em resumir sessoes de RPG de mesa.

    Analise a transcricao e produza os tres campos solicitados em portugues do Brasil.

    Contexto:
    - Campanha: {self.campanha}
    - Narrador: {self.narrador}
    - Personagens: {self.personagens}
    - Jogadores: {self.jogadores}
    - Ouvintes: {self.ouvintes}

    Regras:
    - Seja rigorosamente fiel ao que consta na transcrição.
    - Nao invente fatos, personagens, locais, motivações ou desfechos.
    - Ignore trechos incompreensíveis e detalhes cuja interpretação seja insegura.
    - Diferencie conversas fora do jogo dos acontecimentos narrados quando o contexto permitir.
    - O nome da sessão deve ser curto, chamativo e adequado a um titulo de episodio.
    - O resumo rápido deve conter uma ou duas frases.
    - Prefira três a seis parágrafos na string JSON "resumo_completo". Use \\n\\n entre parágrafos.
    - Preserve os nomes próprios encontrados no texto.
    - Nao inclua comentários sobre a tarefa, sobre a transcrição ou sobre estas regras.

    Regras específicas para o nome da sessão:
    - Nao repita nenhum nome de sessão anterior apresentado abaixo.
    - Evite também títulos quase idênticos aos anteriores.
    - Nao produza títulos na construção "algo entre algo".
    - Prefira títulos curtos, poéticos e relacionados a um acontecimento relevante da sessão.

    NOMES DAS SESSÕES ANTERIORES
    <sessoes_anteriores>
    {lista_sessoes}
    </sessoes_anteriores>

    TRANSCRIÇÃO DA SESSÃO
    <transcricao>
    {roteiro}
    </transcricao>
    """

    def consultar_llm(self, prompt: str) -> dict[str, Any]:
        try:
            return self.client.complete_json(
                prompt,
                self.CAMPOS_OBRIGATORIOS,
                self.max_tentativas,
                validate=self.validar_dados,
            )
        except RuntimeError as erro:
            detalhe = sanitize_error_message(str(erro))
            raise RuntimeError(
                f"Resumo não gerado: {detalhe} Reconecte em Configurações > Inteligência artificial e processe de novo."
            ) from erro

    def validar_dados(self, dados: dict[str, Any]) -> dict[str, str]:
        if not isinstance(dados, dict):
            raise ValueError("A resposta da API não é um objeto JSON.")

        resultado: dict[str, str] = {}

        for campo in self.CAMPOS_OBRIGATORIOS:
            valor = dados.get(campo)
            if not isinstance(valor, str) or not valor.strip():
                raise ValueError(f"Campo ausente ou vazio na resposta: {campo}")
            resultado[campo] = valor.strip()

        texto = resultado["resumo_completo"]

        # Converte quebras de linha literais ("\\n") em quebras reais.
        texto = texto.replace("\\r\\n", "\n")
        texto = texto.replace("\\n", "\n")

        # Normaliza quebras de linha do Windows.
        texto = texto.replace("\r\n", "\n").replace("\r", "\n")

        paragrafos = [
            trecho.strip() for trecho in re.split(r"\n\s*\n", texto) if trecho.strip()
        ]

        if not paragrafos:
            raise ValueError("Campo ausente ou vazio na resposta: resumo_completo")

        resultado["resumo_completo"] = "\n\n".join(paragrafos)

        return resultado

    def metadados_sessao(self) -> dict[str, str]:
        return {
            "Campanha": self.campanha,
            "Narrador": self.narrador,
            "Personagens": self.personagens,
            "Jogadores": self.jogadores,
            "Ouvintes": self.ouvintes,
        }

    def completar_dados(self, dados: dict[str, str]) -> dict[str, str]:
        return {
            **dados,
            **self.metadados_sessao(),
        }

    def gravar_json(self, dados: dict[str, str]) -> None:
        caminho = Path(self.resumo_json_path)
        caminho.parent.mkdir(parents=True, exist_ok=True)
        caminho.write_text(
            json.dumps(dados, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def incluir_resumo_no_roteiro(
        self,
        item: dict[str, str] | None = None,
    ) -> None:
        if not item:
            raise RuntimeError(
                "Gere o resumo antes de inclui-lo no arquivo de roteiro."
            )

        caminho = Path(self.roteiro_path)
        roteiro = caminho.read_text(encoding="utf-8").strip()

        inicio = roteiro.find(self.INICIO_CABECALHO)
        fim = roteiro.find(self.FIM_CABECALHO)

        if inicio != -1 and fim != -1 and fim >= inicio:
            fim += len(self.FIM_CABECALHO)
            roteiro = (roteiro[:inicio] + roteiro[fim:]).strip()

        cabecalho = (
            f"{self.INICIO_CABECALHO}\n"
            f"Campanha: {item['campanha']}\n\n"
            f"Nome da Sessão: {item['nome_sessao']}\n\n"
            f"Narrador: {self.narrador}\n"
            f"Personagens: {self.personagens}\n"
            f"Jogadores: {self.jogadores}\n"
            f"Ouvintes: {self.ouvintes}\n"
            f"Resumo Rápido: {item['resumo_rapido']}\n\n"
            f"Resumo Completo: {item['resumo_completo']}\n"
            f"{self.FIM_CABECALHO}"
        )

        caminho.write_text(
            f"{cabecalho}\n\n{roteiro}\n",
            encoding="utf-8",
        )
        print(f"Resumo incluido no inicio do roteiro: {self.roteiro_path}")

    def gerar_resumo(self) -> tuple[str, str, str]:
        caminho_resumo = Path(self.resumo_json_path)

        if caminho_resumo.is_file() and caminho_resumo.stat().st_size > 10:
            try:
                dados_existentes = json.loads(
                    caminho_resumo.read_text(encoding="utf-8")
                )
                dados_validados = self.validar_dados(dados_existentes)
                dados_validados = self.completar_dados(dados_validados)
                self.gravar_json(dados_validados)
                print(f"Resumo ja gerado, pulando: {self.resumo_json_path}")
                return (
                    dados_validados["nome_sessao"],
                    dados_validados["resumo_rapido"],
                    dados_validados["resumo_completo"],
                )
            except (json.JSONDecodeError, ValueError) as erro:
                print(f"Resumo existente invalido; sera gerado novamente: {erro}")

        roteiro = self.carregar_roteiro()
        prompt = self.montar_prompt(roteiro)
        dados_validados = self.consultar_llm(prompt)

        caminho_debug = Path(self.resumo_json_path).with_suffix(".llm.json")
        caminho_debug.write_text(
            json.dumps(dados_validados, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        dados_validados = self.completar_dados(dados_validados)
        self.gravar_json(dados_validados)

        print(f"Resumo JSON gerado: {self.resumo_json_path}")
        return (
            dados_validados["nome_sessao"],
            dados_validados["resumo_rapido"],
            dados_validados["resumo_completo"],
        )

    @staticmethod
    def nome_seguro(nome: str) -> str:
        nome = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", str(nome)).strip()
        return re.sub(r"\s+", " ", nome).strip(" .") or "Sessao sem nome"

    def renomear_arquivos(
        self,
        nome_sessao: str,
        roteiro_path: str,
    ) -> dict[str, str]:
        pasta = Path(roteiro_path).parent
        base = Path(roteiro_path).stem or self.nome_seguro(nome_sessao)
        novos = {}

        caminhos = {
            "resumo_json_path": Path(self.resumo_json_path),
        }
        destinos = {
            "resumo_json_path": pasta / f"{base}.resumo.json",
        }

        for chave, origem in caminhos.items():
            destino = destinos[chave]
            if origem.exists() and origem != destino:
                if destino.exists():
                    raise FileExistsError(
                        f"Não é possível renomear; destino já existe: {destino}"
                    )
                origem.rename(destino)
            if destino.exists():
                novos[chave] = str(destino)

        self.roteiro_path = roteiro_path
        self.resumo_json_path = novos.get(
            "resumo_json_path",
            str(destinos["resumo_json_path"]),
        )
        self.resumo_path = self.resumo_json_path
        return novos
