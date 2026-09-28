from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable

import psutil


@dataclass(frozen=True, slots=True)
class WeixinSession:
    account_id: str
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


def _has_wxocr_process(processes: list[psutil.Process]) -> bool:
    for process in processes:
        try:
            command = [str(value) for value in process.cmdline() or []]
        except (psutil.AccessDenied, psutil.NoSuchProcess):
            continue
        if any(value.casefold() == "--type=wxocr" for value in command[1:]):
            return True
    return False


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


def require_weixin_session(
    *,
    status: Callable[[str, str], None],
) -> WeixinSession:
    processes = weixin_processes()
    if not processes:
        raise RuntimeError(
            "Weixin is not signed in or the login state is not ready; start Weixin and complete sign-in first"
        )
    status("WEIXIN_RUNNING", f"processes={len(processes)}")
    if not _has_wxocr_process(processes):
        raise RuntimeError("Weixin is not signed in or the login state is not ready; start Weixin and complete sign-in first")
    account_id = _authenticated_account(processes)
    if account_id:
        status("WEIXIN_LOGIN_DETECTED", f"account={account_id}")
    else:
        status(
            "WEIXIN_LOGIN_UNVERIFIED",
            "account database not readable (open_files denied); continuing",
        )
    return WeixinSession(
        account_id=account_id,
        process_ids=tuple(sorted(process.pid for process in processes)),
    )
