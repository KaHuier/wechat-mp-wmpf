from __future__ import annotations

from pathlib import Path
import winreg


def _command_executable(command: str) -> Path | None:
    command = command.strip()
    if command.startswith('"'):
        parts = command.split('"', 2)
        if len(parts) < 2:
            return None
        value = parts[1]
    else:
        position = command.casefold().find(".exe")
        if position < 0:
            return None
        value = command[: position + 4]
    path = Path(value)
    return path.resolve() if path.is_file() else None


def find_weixin_executable(
    weixin_path: str | Path | None = None,
) -> Path:
    if weixin_path is not None:
        path = Path(weixin_path).expanduser()
        if not path.is_file():
            raise FileNotFoundError(f"Weixin executable does not exist: {path}")
        if path.name.casefold() != "weixin.exe":
            raise ValueError(f"Expected Weixin.exe, received: {path.name}")
        return path.resolve()

    protocol_keys = (
        (
            winreg.HKEY_CURRENT_USER,
            r"Software\Classes\weixin\shell\open\command",
        ),
        (
            winreg.HKEY_CLASSES_ROOT,
            r"weixin\shell\open\command",
        ),
    )
    for root, key_path in protocol_keys:
        try:
            with winreg.OpenKey(root, key_path) as key:
                command, _ = winreg.QueryValueEx(key, None)
        except OSError:
            continue
        executable = _command_executable(str(command))
        if executable:
            return executable

    uninstall_key = (
        r"Software\WOW6432Node\Microsoft\Windows"
        r"\CurrentVersion\Uninstall\Weixin"
    )
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, uninstall_key) as key:
            try:
                display_icon, _ = winreg.QueryValueEx(key, "DisplayIcon")
                executable = _command_executable(str(display_icon))
                if executable:
                    return executable
            except OSError:
                pass
            try:
                install_location, _ = winreg.QueryValueEx(key, "InstallLocation")
                executable = Path(str(install_location).strip('"')) / "Weixin.exe"
                if executable.is_file():
                    return executable.resolve()
            except OSError:
                pass
    except OSError:
        pass
    raise FileNotFoundError("Weixin.exe was not found in the registry")
