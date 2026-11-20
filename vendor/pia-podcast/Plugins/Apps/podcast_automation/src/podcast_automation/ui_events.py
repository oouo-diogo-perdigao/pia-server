"""Eventos de interface; a CLI mantém sua saída de texto normal."""

import json
import os

STAGES = (
    "Obter ZIP",
    "Extrair e identificar",
    "Mixar áudio",
    "Editar e compilar",
    "Transcrever",
    "Gerar legendas",
    "Gerar resumo",
    "Preparar arquivos",
    "Publicar",
    "Atualizar RSS e página",
    "Finalizar e limpar",
)


def emit(kind, **values):
    if os.getenv("CRAIG_GUI_EVENTS") == "1":
        print(
            "@@CRAIG " + json.dumps(dict(kind=kind, **values), ensure_ascii=False),
            flush=True,
        )


def stage(index):
    emit("stage", index=index)
