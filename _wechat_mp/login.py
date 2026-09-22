from __future__ import annotations

import re
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import psutil
import win32con
import win32gui
import win32process


@dataclass(frozen=True, slots=True)
class LoginInfo:
    account_id: str
    executable: Path
    process_ids: tuple[int, ...]


def weixin_processes() -> list[psutil.Process]:
    output: list[psutil.Process] = []
    for process in psutil.process_iter(["name"]):
        try:
            if str(process.info.get("name") or "").casefold() == "weixin.exe":
                output.append(process)
        except (psutil.AccessDenied, psutil.NoSuchProcess):
            continue
    return output


def _largest_window(
    process_ids: set[int],
) -> tuple[int, tuple[int, int, int, int]] | None:
    candidates: list[tuple[int, tuple[int, int, int, int]]] = []

    def callback(hwnd: int, _: object) -> None:
        if not win32gui.IsWindowVisible(hwnd):
            return
        _, process_id = win32process.GetWindowThreadProcessId(hwnd)
        if process_id not in process_ids:
            return
        rect = win32gui.GetWindowRect(hwnd)
        width = max(0, rect[2] - rect[0])
        height = max(0, rect[3] - rect[1])
        if width >= 200 and height >= 250:
            candidates.append((hwnd, rect))

    win32gui.EnumWindows(callback, None)
    return max(
        candidates,
        key=lambda item: (item[1][2] - item[1][0]) * (item[1][3] - item[1][1]),
        default=None,
    )


def _looks_like_main_window(rect: tuple[int, int, int, int]) -> bool:
    return rect[2] - rect[0] >= 520 and rect[3] - rect[1] >= 430


def _authenticated_account(processes: list[psutil.Process]) -> str:
    login_pattern = re.compile(
        r"[\\/]all_users[\\/]login[\\/](wxid_[^\\/]+)[\\/]key_info\.db"
        r"(?:-(?:wal|shm))?$",
        re.IGNORECASE,
    )
    profile_pattern = re.compile(
        r"[\\/]xwechat_files[\\/]([^\\/]+)[\\/]db_storage[\\/]",
        re.IGNORECASE,
    )
    profile_name = ""
    for process in processes:
        try:
            opened_files = process.open_files()
        except (psutil.AccessDenied, psutil.NoSuchProcess):
            continue
        for opened_file in opened_files:
            path = str(getattr(opened_file, "path", "") or "")
            login_match = login_pattern.search(path)
            if login_match:
                return login_match.group(1)
            profile_match = profile_pattern.search(path)
            if profile_match:
                profile_name = profile_match.group(1)
    if profile_name.casefold() not in {"", "all_users", "applet"}:
        return profile_name
    return ""


def _show_window(processes: list[psutil.Process]) -> None:
    window = _largest_window({process.pid for process in processes})
    if window is None:
        return
    hwnd = window[0]
    try:
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        win32gui.BringWindowToTop(hwnd)
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        pass


def wait_for_login(
    executable: Path,
    *,
    timeout: float,
    status: Callable[[str, str], None],
) -> LoginInfo:
    processes = weixin_processes()
    if not processes:
        status("STARTING_WEIXIN", str(executable))
        subprocess.Popen([str(executable)], cwd=str(executable.parent))
    else:
        status("WEIXIN_RUNNING", f"processes={len(processes)}")

    deadline = time.monotonic() + timeout
    requested_window = False
    last_state = ""
    while time.monotonic() < deadline:
        processes = weixin_processes()
        if not processes:
            state = "WAITING_PROCESS"
        else:
            account_id = _authenticated_account(processes)
            window = _largest_window({process.pid for process in processes})
            if account_id and window and _looks_like_main_window(window[1]):
                status("LOGIN_READY", f"account={account_id}")
                return LoginInfo(
                    account_id=account_id,
                    executable=executable,
                    process_ids=tuple(sorted(process.pid for process in processes)),
                )
            state = "WAITING_LOGIN"
            if not requested_window:
                if window is None:
                    subprocess.Popen([str(executable)], cwd=str(executable.parent))
                else:
                    _show_window(processes)
                requested_window = True
        if state != last_state:
            status(state, "Complete sign-in in the visible Weixin window")
            last_state = state
        time.sleep(1.0)
    raise TimeoutError(f"Weixin login did not complete within {timeout:.0f} seconds")
