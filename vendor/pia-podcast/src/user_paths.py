"""Persistent user files follow the OS Documents folder; runtime caches stay local."""

import os
import re
import sys
from pathlib import Path


def documents_folder():
    home = Path.home()
    if sys.platform == "win32":
        try:
            import winreg

            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
            ) as key:
                return Path(os.path.expandvars(winreg.QueryValueEx(key, "Personal")[0]))
        except OSError:
            pass
    else:
        file = (
            Path(os.environ.get("XDG_CONFIG_HOME", home / ".config")) / "user-dirs.dirs"
        )
        if file.is_file():
            match = re.search(
                r'^XDG_DOCUMENTS_DIR="([^"]+)"', file.read_text(encoding="utf-8"), re.M
            )
            if match:
                value = match[1].replace("$HOME", str(home))
                if Path(value).is_absolute():
                    return Path(value)
    return home / "Documents"


USER_DIR = documents_folder() / "pia"


def user_path(*parts):
    path = USER_DIR.joinpath(*parts)
    if not path.resolve().is_relative_to(USER_DIR.resolve()):
        raise ValueError("Caminho de dados inválido.")
    return path
