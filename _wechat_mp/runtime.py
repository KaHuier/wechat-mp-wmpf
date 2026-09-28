from __future__ import annotations

import asyncio
import ctypes
import hashlib
import json
import os
import shutil
import subprocess
import time
from ctypes import wintypes
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator
from urllib.parse import urlparse

import psutil
import win32con
import win32gui
import win32process
from websockets.sync.client import connect as sync_connect

from .client import CDP_URL, SEARCH_MARKER, SEARCH_URI, WeChatMP as AsyncWeChatMP
from .login import WeixinSession, require_weixin_session
from .models import (
    Article,
    ArticleCollection,
    ArticlePage,
    OfficialAccountInfo,
    ProfileTarget,
)


PROJECT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DEBUGGER_DIR = Path(
    os.environ.get("WMPF_DEBUGGER_DIR", "").strip()
).expanduser() if os.environ.get("WMPF_DEBUGGER_DIR", "").strip() else None
DETACH_SCRIPT = PROJECT_DIR / "tools" / "invoke_search_detach.js"
OPEN_SEARCH_SCRIPT = PROJECT_DIR / "tools" / "open_search_tab.js"
WMPF_RUNTIME_HASHES = {
    25710: "3211EE33FD42F96EDF8390E641AF671A47B77D03CC09C4723DAFDBAE5CF75665",
    25715: "5BAF4A84A41036CE5B2EF897D85029BDE9EE9965B4A69D4F5B594672821CAD56",
}
WMPF_25715_DEVTOOLS_START_OFFSET = 0x369CB70


@dataclass(frozen=True, slots=True)
class RuntimeEvent:
    state: str
    message: str


StatusCallback = Callable[[RuntimeEvent], None]


class OfficialAccount:
    """An official account bound to a running WeChat runtime."""

    __slots__ = ("_runtime", "_info")

    def __init__(self, runtime: WeChatRuntime, info: OfficialAccountInfo) -> None:
        self._runtime = runtime
        self._info = info

    @property
    def info(self) -> OfficialAccountInfo:
        return self._info

    @property
    def name(self) -> str:
        return self._info.name

    @property
    def user_name(self) -> str:
        return self._info.user_name

    @property
    def alias(self) -> str:
        return self._info.alias

    @property
    def bizuin(self) -> str:
        return self._info.bizuin

    @property
    def signature(self) -> str:
        return self._info.signature

    def to_dict(self) -> dict[str, Any]:
        return self._info.to_dict()

    def article_pages(
        self,
        *,
        max_pages: int | None = None,
        delay: float = 0.8,
    ) -> ArticlePager:
        return ArticlePager(
            self._runtime,
            self,
            max_pages=max_pages,
            delay=delay,
        )

    def articles(
        self,
        *,
        max_pages: int | None = None,
        delay: float = 0.8,
    ) -> Iterator[Article]:
        for page in self.article_pages(max_pages=max_pages, delay=delay):
            yield from page.articles

    def collect_all_articles(self, *, delay: float = 0.8) -> ArticleCollection:
        articles: list[Article] = []
        pages_loaded = 0
        is_end = False
        for page in self.article_pages(delay=delay):
            pages_loaded += 1
            articles.extend(page.articles)
            is_end = page.is_end
        return ArticleCollection(
            account=self._info,
            articles=tuple(articles),
            pages_loaded=pages_loaded,
            is_end=is_end,
        )

    def __repr__(self) -> str:
        return f"OfficialAccount(name={self.name!r}, user_name={self.user_name!r})"


class ArticlePager:
    """Lazy, synchronous iterator over newly loaded article batches."""

    __slots__ = (
        "_runtime",
        "_account",
        "_max_pages",
        "_delay",
        "_profile",
        "_seen",
        "_number",
        "_is_end",
        "_closed",
    )

    def __init__(
        self,
        runtime: WeChatRuntime,
        account: OfficialAccount,
        *,
        max_pages: int | None,
        delay: float,
    ) -> None:
        if max_pages is not None and max_pages <= 0:
            raise ValueError("max_pages must be positive or None")
        if delay < 0:
            raise ValueError("delay must not be negative")
        self._runtime = runtime
        self._account = account
        self._max_pages = max_pages
        self._delay = delay
        self._profile: ProfileTarget | None = None
        self._seen: set[str] = set()
        self._number = 0
        self._is_end = False
        self._closed = False

    def __iter__(self) -> ArticlePager:
        return self

    def __next__(self) -> ArticlePage:
        return self.next_page()

    def next_page(self) -> ArticlePage:
        if self._closed or self._is_end:
            raise StopIteration
        if self._max_pages is not None and self._number >= self._max_pages:
            self._closed = True
            raise StopIteration

        if self._profile is None:
            self._profile, payload = self._runtime._open_first_article_page(self._account)
        else:
            payload = self._runtime._load_next_article_page(
                self._profile,
                delay=self._delay,
            )

        new_articles: list[Article] = []
        for value in payload.get("articles") or []:
            article = Article.from_dict(value)
            if article.key in self._seen:
                continue
            self._seen.add(article.key)
            new_articles.append(article)

        state = payload.get("state") or {}
        self._number += 1
        self._is_end = bool(state.get("is_end"))
        return ArticlePage(
            number=self._number,
            articles=tuple(new_articles),
            offset=state.get("offset"),
            is_end=self._is_end,
        )

    def close(self) -> None:
        self._closed = True


def _default_status(event: RuntimeEvent) -> None:
    print(f"[{event.state}] {event.message}", flush=True)


class WeChatRuntime:
    def __init__(
        self,
        *,
        bootstrap_app_id: str,
        cdp_url: str = CDP_URL,
        startup_timeout: float = 45.0,
        wmpf_debugger_dir: str | Path | None = None,
        status_callback: StatusCallback | None = None,
    ) -> None:
        self.bootstrap_app_id = bootstrap_app_id.strip()
        self.cdp_url = cdp_url
        self.startup_timeout = startup_timeout
        debugger_dir = Path(wmpf_debugger_dir).expanduser() if wmpf_debugger_dir else DEFAULT_DEBUGGER_DIR
        if debugger_dir is None:
            raise ValueError("wmpf_debugger_dir is required; clone https://github.com/evi0s/WMPFDebugger first")
        self.debugger_dir = debugger_dir.resolve()
        self.status_callback = status_callback or _default_status
        self.weixin_session: WeixinSession | None = None
        self._owned_processes: list[subprocess.Popen[Any]] = []
        self._search_window_handles: set[int] = set()
        self._started = False
        self._reused_debugger = False

    def __enter__(self) -> WeChatRuntime:
        return self.start()

    def __exit__(self, *_: object) -> None:
        self.close()

    def _status(self, state: str, message: str) -> None:
        self.status_callback(RuntimeEvent(state=state, message=message))

    def start(self) -> WeChatRuntime:
        if self._started:
            return self
        if not self.bootstrap_app_id:
            raise ValueError("bootstrap_app_id must not be empty")
        self.weixin_session = require_weixin_session(
            status=self._status,
        )
        try:
            self._ensure_debug_runtime()
        except Exception:
            self.close()
            raise
        self._started = True
        self._status("READY", self.cdp_url)
        return self

    def close(self) -> None:
        closed_searches = _close_search_targets(self.cdp_url, keep_primary=False)
        closed_windows = _close_window_handles(set(self._search_window_handles))
        self._search_window_handles.clear()
        if closed_searches or closed_windows:
            self._status(
                "SEARCH_CLOSED",
                f"targets={closed_searches} windows={closed_windows}",
            )
        for process in self._owned_processes:
            if process.poll() is None:
                process.terminate()
        for process in self._owned_processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        self._owned_processes.clear()
        self._started = False

    def search(
        self,
        query: str,
        *,
        exact: bool = True,
    ) -> list[OfficialAccount]:
        self._require_started()

        async def operation() -> list[OfficialAccount]:
            async with AsyncWeChatMP(self.cdp_url) as client:
                matches = await client.search(query, exact=exact)
                return [OfficialAccount(self, match) for match in matches]

        return asyncio.run(operation())

    def search_one(
        self,
        query: str,
        *,
        user_name: str = "",
    ) -> OfficialAccount:
        matches = self.search(query, exact=True)
        if user_name:
            matches = [match for match in matches if match.user_name == user_name]
        if len(matches) != 1:
            raise RuntimeError(
                f"expected one exact account for {query!r}, got {len(matches)}; "
                "pass user_name when names collide"
            )
        return matches[0]

    def _open_first_article_page(
        self,
        account: OfficialAccount,
    ) -> tuple[ProfileTarget, dict[str, Any]]:
        self._require_started()

        async def operation() -> tuple[ProfileTarget, dict[str, Any]]:
            async with AsyncWeChatMP(self.cdp_url) as client:
                profile = await client.open_account(account.info)
                payload = await client.prepare_article_page(profile)
                return profile, payload

        return asyncio.run(operation())

    def _load_next_article_page(
        self,
        profile: ProfileTarget,
        *,
        delay: float,
    ) -> dict[str, Any]:
        self._require_started()

        async def operation() -> dict[str, Any]:
            async with AsyncWeChatMP(self.cdp_url) as client:
                return await client.next_article_page(profile, delay=delay)

        return asyncio.run(operation())

    def _require_started(self) -> None:
        if not self._started:
            raise RuntimeError("The runtime is not started")

    def _ensure_debug_runtime(self) -> None:
        if _cdp_healthy(self.cdp_url, timeout=1.5):
            self._reused_debugger = True
            self._status("DEBUGGER_REUSED", self.cdp_url)
            self._ensure_search_target()
            return
        _stop_stale_debugger(self.cdp_url, self.debugger_dir, self._status)
        root, _ = _ensure_wmpf_root(
            self.startup_timeout, self._status, self.debugger_dir
        )
        self._start_debugger(root)
        endpoint = _enable_xweb_use(root, self._status, self.debugger_dir)
        response = _xweb_request(
            endpoint,
            "XWeb.LaunchApplet",
            {"app_id": self.bootstrap_app_id, "headless": 1},
            timeout=10.0,
        )
        launched_app_id = str((response.get("result") or {}).get("app_id") or "")
        if launched_app_id != self.bootstrap_app_id:
            raise RuntimeError(f"Applet launch failed: {response}")
        self._status("BOOTSTRAP_APPLET_STARTED", f"app_id={launched_app_id} headless=1")
        if not _wait_until(
            lambda: _cdp_healthy(self.cdp_url, timeout=1.0),
            self.startup_timeout,
        ):
            raise RuntimeError(
                "The bootstrap applet did not establish the CDP channel before timeout"
            )
        self._status("CDP_READY", self.cdp_url)
        # Launching the bootstrap applet can replace the WMPF container, dropping
        # any Search page opened before it. Always open Search after bootstrap so
        # the target exists in the live CDP session.
        self._ensure_search_target(search_opened=False)

    def _start_debugger(self, root: psutil.Process | None = None) -> None:
        node = shutil.which("node")
        if not node:
            raise RuntimeError("node.exe is not available on PATH")
        ts_node = self.debugger_dir / "node_modules" / "ts-node" / "dist" / "bin.js"
        if not ts_node.is_file():
            raise RuntimeError(f"WMPFDebugger dependencies are missing: {ts_node}")
        logs = PROJECT_DIR / "logs"
        logs.mkdir(exist_ok=True)
        log_path = logs / "wmpf-debugger.log"
        log_offset = log_path.stat().st_size if log_path.exists() else 0
        live_root = root or _find_wmpf_root()
        if live_root is None:
            raise RuntimeError("The WMPF root process is not running")
        hook_path = self.debugger_dir / "frida" / "hook.js"
        original_hook, patched_hook, runtime_version = _prepare_wmpf_debugger_hook(
            live_root,
            hook_path,
        )
        hook_path.write_bytes(patched_hook)
        self._status("DEBUGGER_PATCHED", f"runtime={runtime_version}")
        try:
            with log_path.open("ab") as output:
                process = subprocess.Popen(
                    [node, str(ts_node), "src/index.ts", "--auto-detect"],
                    cwd=str(self.debugger_dir),
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            self._owned_processes.append(process)
            self._status("DEBUGGER_STARTING", f"pid={process.pid}")
            if not _wait_log(log_path, "[frida] script loaded", log_offset, self.startup_timeout):
                raise RuntimeError(f"WMPFDebugger did not finish Frida injection: {log_path}")
            self._status("DEBUGGER_ATTACHED", f"pid={process.pid}")
        finally:
            hook_path.write_bytes(original_hook)
            self._status("DEBUGGER_PATCH_RESTORED", str(hook_path))

    def _ensure_search_target(self, *, search_opened: bool = False) -> None:
        windows_before = set(_visible_wmpf_windows())
        if not search_opened and _cdp_has_target(self.cdp_url, SEARCH_MARKER):
            duplicates = _close_search_targets(self.cdp_url, keep_primary=True)
            if duplicates:
                self._status("SEARCH_DUPLICATES_CLOSED", f"count={duplicates}")
            self._status("SEARCH_READY", "existing target")
            return
        self._status("SEARCH_STARTING", SEARCH_URI)
        # A cold start already opened Search in _ensure_wmpf_root() to create the
        # WMPF process. Reuse that page and detach it instead of opening a second
        # Search page here.
        if not search_opened:
            _open_search_native(self.debugger_dir)
        root = _wait_for_live_wmpf_root(20.0)
        node = shutil.which("node")
        if not node:
            raise RuntimeError("node.exe is not available on PATH")
        completed = subprocess.run(
            [node, str(DETACH_SCRIPT), str(root.pid), str(_ui_thread_id(root))],
            cwd=str(PROJECT_DIR),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=25,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            env={**os.environ, "WMPF_DEBUGGER_DIR": str(self.debugger_dir)},
        )
        if completed.returncode != 0:
            detail = completed.stderr.strip() or completed.stdout.strip()
            raise RuntimeError(f"Search detach failed with exit {completed.returncode}: {detail}")
        if not _wait_until(lambda: _cdp_has_target(self.cdp_url, SEARCH_MARKER), 20.0):
            raise RuntimeError("The Search target did not appear in CDP")
        duplicates = _close_search_targets(self.cdp_url, keep_primary=True)
        if duplicates:
            self._status("SEARCH_DUPLICATES_CLOSED", f"count={duplicates}")
        time.sleep(0.25)
        self._search_window_handles.update(
            set(_visible_wmpf_windows()) - windows_before
        )
        self._status("SEARCH_READY", "detached target")


def _wait_until(predicate: Callable[[], bool], timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.25)
    return False


def _cdp_request(cdp_url: str, *, timeout: float) -> dict[str, Any] | None:
    try:
        request_id = int(time.time_ns() % 2_000_000_000)
        with sync_connect(
            cdp_url,
            open_timeout=timeout,
            close_timeout=min(timeout, 0.5),
        ) as socket:
            socket.send(json.dumps({"id": request_id, "method": "Target.getTargets"}))
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                payload = json.loads(
                    socket.recv(timeout=max(0.05, deadline - time.monotonic()))
                )
                if payload.get("id") == request_id:
                    return payload
    except Exception:
        return None
    return None


def _cdp_healthy(cdp_url: str, *, timeout: float) -> bool:
    response = _cdp_request(cdp_url, timeout=timeout)
    return isinstance((response or {}).get("result", {}).get("targetInfos"), list)


def _cdp_has_target(cdp_url: str, marker: str) -> bool:
    response = _cdp_request(cdp_url, timeout=2.0)
    targets = (response or {}).get("result", {}).get("targetInfos") or []
    return any(
        target.get("type") == "page" and marker in str(target.get("url") or "")
        for target in targets
    )


def _cdp_close_target(cdp_url: str, target_id: str, *, timeout: float = 2.0) -> bool:
    try:
        request_id = int(time.time_ns() % 2_000_000_000)
        with sync_connect(
            cdp_url,
            open_timeout=timeout,
            close_timeout=min(timeout, 0.5),
        ) as socket:
            socket.send(
                json.dumps(
                    {
                        "id": request_id,
                        "method": "Target.closeTarget",
                        "params": {"targetId": target_id},
                    }
                )
            )
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                payload = json.loads(
                    socket.recv(timeout=max(0.05, deadline - time.monotonic()))
                )
                if payload.get("id") == request_id:
                    return bool((payload.get("result") or {}).get("success"))
    except Exception:
        return False
    return False


def _close_search_targets(cdp_url: str, *, keep_primary: bool) -> int:
    response = _cdp_request(cdp_url, timeout=2.0)
    targets = [
        target
        for target in (response or {}).get("result", {}).get("targetInfos") or []
        if target.get("type") == "page"
        and SEARCH_MARKER in str(target.get("url") or "")
    ]
    keep_id = ""
    if keep_primary and targets:
        primary = next(
            (
                target
                for target in reversed(targets)
                if "type=0" in str(target.get("url") or "")
            ),
            targets[-1],
        )
        keep_id = str(primary.get("targetId") or "")
    closed = 0
    for target in targets:
        target_id = str(target.get("targetId") or "")
        if not target_id or target_id == keep_id:
            continue
        if _cdp_close_target(cdp_url, target_id):
            closed += 1
    return closed


def _xweb_request(
    endpoint: str,
    method: str,
    params: dict[str, Any],
    *,
    timeout: float,
) -> dict[str, Any]:
    request_id = int(time.time_ns() % 2_000_000_000)
    with sync_connect(endpoint, open_timeout=timeout, close_timeout=0.5) as socket:
        socket.send(json.dumps({"id": request_id, "method": method, "params": params}))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            response = json.loads(
                socket.recv(timeout=max(0.05, deadline - time.monotonic()))
            )
            if response.get("id") == request_id:
                if response.get("error"):
                    raise RuntimeError(f"XWeb command failed: {response['error']}")
                return response
    raise TimeoutError(f"XWeb command timed out: {method}")


def _enable_xweb_use(
    root: psutil.Process,
    status: Callable[[str, str], None],
    debugger_dir: Path,
) -> str:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node.exe is not available on PATH")
    enable_xweb_script = PROJECT_DIR / "tools" / "enable-xweb-use-ws.js"
    if not enable_xweb_script.is_file():
        raise RuntimeError(f"XWeb helper is missing: {enable_xweb_script}")
    thread_id = _ui_thread_id(root)
    completed = subprocess.run(
        [node, str(enable_xweb_script), str(root.pid), str(thread_id), "15000"],
        cwd=str(debugger_dir),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=20,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        env={
            **os.environ,
            "WMPF_PROJECT_DIR": str(PROJECT_DIR),
            "NODE_PATH": str(debugger_dir / "node_modules"),
        },
    )
    endpoint = ""
    event: dict[str, Any] = {}
    for line in completed.stdout.splitlines():
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if candidate.get("event") == "completed":
            event = candidate
            endpoint = str(candidate.get("endpoint") or "")
    if completed.returncode != 0 or not endpoint:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"XWeb control channel failed: {detail}")
    status(
        "XWEB_CONTROL_READY",
        f"state={event.get('state')} port={event.get('port')}",
    )
    return endpoint


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def _wmpf_runtime_identity(root: psutil.Process) -> tuple[int, str]:
    runtime_dir: Path | None = None
    for argument in root.cmdline():
        if argument.startswith("--flue-runtime-dir="):
            runtime_dir = Path(argument.split("=", 1)[1])
            break
    if runtime_dir is None:
        raise RuntimeError(f"WMPF root {root.pid} has no --flue-runtime-dir argument")
    try:
        version = int(runtime_dir.parents[1].name)
    except (IndexError, ValueError) as error:
        raise RuntimeError(f"Cannot determine WMPF runtime version from {runtime_dir}") from error
    flue_path = runtime_dir / "flue.dll"
    if not flue_path.is_file():
        raise RuntimeError(f"WMPF runtime library is missing: {flue_path}")
    return version, _sha256_file(flue_path)


def _build_wmpf_debugger_hook(source: str, runtime_version: int) -> str:
    scene_marker = "const sceneNumberArray = ["
    scene_start = source.find(scene_marker)
    scene_end = source.find("];", scene_start)
    if scene_start < 0 or scene_end < 0:
        raise RuntimeError("WMPFDebugger hook.js scene array was not found")
    scene_end += 2
    scene_block = source[scene_start:scene_end]
    if "1000," not in scene_block:
        scene_block = scene_block.replace("[", "[\n        1000,", 1)
        source = source[:scene_start] + scene_block + source[scene_end:]

    if runtime_version != 25715 or "[start-once] installed" in source:
        return source

    main_marker = "const main = () => {"
    main_start = source.find(main_marker)
    if main_start < 0:
        raise RuntimeError("WMPFDebugger hook.js main function was not found")
    guard = f'''const retainedStartCallbacks = [];
const patchDevToolsStartOnce = (base, config) => {{
    if (config.Version !== 25715) return;
    const address = base.add(0x{WMPF_25715_DEVTOOLS_START_OFFSET:x});
    const original = new NativeFunction(address, "void", ["pointer", "pointer"]);
    const started = new Set();
    const replacement = new NativeCallback((self, argument) => {{
        const key = self.toString();
        if (started.has(key)) {{
            send(`[start-once] skip duplicate this=${{key}} argument=${{argument}}`);
            return;
        }}
        started.add(key);
        send(`[start-once] first this=${{key}} argument=${{argument}}`);
        original(self, argument);
    }}, "void", ["pointer", "pointer"]);
    retainedStartCallbacks.push(replacement);
    Interceptor.replace(address, replacement);
    send(`[start-once] installed at ${{address}}`);
}};

'''
    source = source[:main_start] + guard + source[main_start:]
    call_marker = "    const mainModule = getMainModule(config.Version);"
    call_start = source.find(call_marker)
    if call_start < 0:
        raise RuntimeError("WMPFDebugger hook.js main module initialization was not found")
    call_end = call_start + len(call_marker)
    newline = "\r\n" if "\r\n" in source else "\n"
    return (
        source[:call_end]
        + newline
        + "    patchDevToolsStartOnce(mainModule.base, config);"
        + source[call_end:]
    )


def _prepare_wmpf_debugger_hook(
    root: psutil.Process,
    hook_path: Path,
) -> tuple[bytes, bytes, int]:
    if not hook_path.is_file():
        raise RuntimeError(f"WMPFDebugger hook is missing: {hook_path}")
    runtime_version, flue_hash = _wmpf_runtime_identity(root)
    expected_hash = WMPF_RUNTIME_HASHES.get(runtime_version)
    if expected_hash is None or flue_hash != expected_hash:
        raise RuntimeError(
            "Unsupported WMPF runtime for the debugger patch: "
            f"version={runtime_version} flue_sha256={flue_hash}"
        )
    original = hook_path.read_bytes()
    source = original.decode("utf-8")
    patched = _build_wmpf_debugger_hook(source, runtime_version).encode("utf-8")
    return original, patched, runtime_version


def _listener_pids(port: int) -> set[int]:
    output: set[int] = set()
    for connection in psutil.net_connections(kind="tcp"):
        if connection.status != psutil.CONN_LISTEN or not connection.laddr:
            continue
        if connection.laddr.port == port and connection.pid:
            output.add(connection.pid)
    return output


def _stop_stale_debugger(
    cdp_url: str,
    debugger_dir: Path,
    status: Callable[[str, str], None],
) -> None:
    port = urlparse(cdp_url).port or 62000
    expected = str(debugger_dir.resolve()).casefold()
    for process_id in _listener_pids(port):
        try:
            process = psutil.Process(process_id)
            command = " ".join(process.cmdline()).casefold()
            name = process.name().casefold()
        except (psutil.AccessDenied, psutil.NoSuchProcess):
            continue
        is_bundled = expected in command
        is_legacy_debugger = "wmpfdebugger" in command and "ts-node" in command
        if (
            name != "node.exe"
            or "src/index.ts" not in command
            or not (is_bundled or is_legacy_debugger)
        ):
            raise RuntimeError(f"Port {port} is owned by an unrelated process: pid={process_id}")
        status("STOPPING_STALE_DEBUGGER", f"pid={process_id}")
        process.terminate()
        try:
            process.wait(timeout=5)
        except psutil.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    if not _wait_until(lambda: not _listener_pids(port), 5.0):
        raise RuntimeError(f"Port {port} is still occupied")


def _find_wmpf_root() -> psutil.Process | None:
    roots: list[psutil.Process] = []
    for process in psutil.process_iter(["name", "cmdline", "create_time"]):
        try:
            if str(process.info.get("name") or "").casefold() != "wechatappex.exe":
                continue
            command = [str(value) for value in process.info.get("cmdline") or []]
            if any(value.startswith("--type=") for value in command[1:]):
                continue
            roots.append(process)
        except (psutil.AccessDenied, psutil.NoSuchProcess):
            continue
    return max(roots, key=lambda process: process.create_time(), default=None)


def _find_weixin_root() -> psutil.Process | None:
    roots: list[psutil.Process] = []
    dll_roots: list[psutil.Process] = []
    for process in psutil.process_iter(["name", "cmdline", "create_time", "ppid"]):
        try:
            if str(process.info.get("name") or "").casefold() != "weixin.exe":
                continue
            command = [str(value) for value in process.info.get("cmdline") or []]
            # The primary client is the Weixin.exe launched by Explorer. All
            # --type=... instances are Chromium/plugin children.
            if any(value.startswith("--type=") for value in command[1:]):
                continue
            try:
                parent = process.parent()
                if parent is not None and parent.name().casefold() == "weixin.exe":
                    continue
            except (psutil.AccessDenied, psutil.NoSuchProcess):
                pass
            roots.append(process)
            try:
                if any(Path(m.path).name.casefold() == "wmpf_host_export_x64.dll" for m in process.memory_maps()):
                    dll_roots.append(process)
            except (psutil.AccessDenied, psutil.NoSuchProcess):
                pass
        except (psutil.AccessDenied, psutil.NoSuchProcess):
            continue
    candidates = dll_roots or roots
    return max(candidates, key=lambda process: process.create_time(), default=None)


def _largest_process_window(process_id: int) -> tuple[int, int] | None:
    candidates: list[tuple[int, int, int]] = []

    def callback(hwnd: int, _: object) -> None:
        if not win32gui.IsWindowVisible(hwnd):
            return
        thread_id, owner_pid = win32process.GetWindowThreadProcessId(hwnd)
        if owner_pid != process_id:
            return
        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        area = max(0, right - left) * max(0, bottom - top)
        if area > 0:
            candidates.append((area, hwnd, thread_id))

    win32gui.EnumWindows(callback, None)
    if not candidates:
        return None
    _, hwnd, thread_id = max(candidates)
    return hwnd, thread_id


def _open_search_native(debugger_dir: Path | None = None) -> None:
    root = _find_weixin_root()
    if root is None:
        raise RuntimeError("The unified Weixin root process is not running")
    window = _largest_process_window(root.pid)
    if window is None:
        raise RuntimeError(f"The unified Weixin UI window is unavailable: pid={root.pid}")
    hwnd, thread_id = window
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node.exe is not available on PATH")
    completed = subprocess.run(
        [node, str(OPEN_SEARCH_SCRIPT), str(root.pid), str(thread_id), hex(hwnd), SEARCH_URI],
        cwd=str(PROJECT_DIR),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=20,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        env={
            **os.environ,
            **({"WMPF_DEBUGGER_DIR": str(debugger_dir)} if debugger_dir else {}),
        },
    )
    if completed.returncode != 0 or '"event":"completed"' not in completed.stdout:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"Native Search AddTab failed: {detail}")


def _visible_wmpf_windows() -> list[int]:
    windows: list[int] = []

    def callback(hwnd: int, _: object) -> None:
        if not win32gui.IsWindowVisible(hwnd):
            return
        _, owner_pid = win32process.GetWindowThreadProcessId(hwnd)
        try:
            name = psutil.Process(owner_pid).name().casefold()
        except (psutil.AccessDenied, psutil.NoSuchProcess):
            return
        if name == "wechatappex.exe" and win32gui.GetClassName(hwnd) == "Chrome_WidgetWin_0":
            windows.append(hwnd)

    win32gui.EnumWindows(callback, None)
    return windows


def _close_window_handles(handles: set[int], *, timeout: float = 5.0) -> int:
    windows = [hwnd for hwnd in handles if win32gui.IsWindow(hwnd)]
    for hwnd in windows:
        win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not any(win32gui.IsWindow(hwnd) for hwnd in windows):
            break
        time.sleep(0.1)
    return len(windows)


def _ensure_wmpf_root(
    timeout: float,
    status: Callable[[str, str], None],
    debugger_dir: Path | None = None,
) -> tuple[psutil.Process, bool]:
    existing = _find_wmpf_root()
    if existing is not None and _visible_wmpf_windows():
        status("WMPF_ROOT_READY", f"pid={existing.pid}")
        return existing, False
    status("WMPF_ROOT_STARTING", SEARCH_URI)
    _open_search_native(debugger_dir)

    def search_root_ready() -> bool:
        root = _find_wmpf_root()
        return root is not None and bool(_visible_wmpf_windows())

    if not _wait_until(search_root_ready, timeout):
        raise RuntimeError("The WMPF root process did not start")
    root = _find_wmpf_root()
    assert root is not None
    status("WMPF_ROOT_READY", f"pid={root.pid}")
    return root, True


def _wait_for_live_wmpf_root(timeout: float) -> psutil.Process:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        root = _find_wmpf_root()
        if root is not None:
            try:
                if not hasattr(root, "threads") or root.threads():
                    return root
            except (psutil.AccessDenied, psutil.NoSuchProcess):
                pass
        time.sleep(0.25)
    raise RuntimeError("The WMPF root process did not start")

def _ui_thread_id(process: psutil.Process) -> int:
    class FileTime(ctypes.Structure):
        _fields_ = [("low", wintypes.DWORD), ("high", wintypes.DWORD)]

    kernel32 = ctypes.windll.kernel32
    kernel32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenThread.restype = wintypes.HANDLE
    ranked: list[tuple[int, int]] = []
    for thread in process.threads():
        handle = kernel32.OpenThread(0x0800, False, thread.id)
        if not handle:
            continue
        creation, exit_time, kernel, user = (FileTime() for _ in range(4))
        try:
            if kernel32.GetThreadTimes(
                handle,
                ctypes.byref(creation),
                ctypes.byref(exit_time),
                ctypes.byref(kernel),
                ctypes.byref(user),
            ):
                created = (int(creation.high) << 32) | int(creation.low)
                ranked.append((created, thread.id))
        finally:
            kernel32.CloseHandle(handle)
    if ranked:
        return min(ranked)[1]
    return max(process.threads(), key=lambda item: item.user_time + item.system_time).id


def _wait_log(path: Path, marker: str, offset: int, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with path.open("rb") as source:
                source.seek(offset)
                if marker in source.read().decode("utf-8", errors="replace"):
                    return True
        except OSError:
            pass
        time.sleep(0.25)
    return False


def start_runtime(
    *,
    bootstrap_app_id: str,
    cdp_url: str = CDP_URL,
    startup_timeout: float = 45.0,
    wmpf_debugger_dir: str | Path | None = None,
    status_callback: StatusCallback | None = None,
) -> WeChatRuntime:
    return WeChatRuntime(
        bootstrap_app_id=bootstrap_app_id,
        cdp_url=cdp_url,
        startup_timeout=startup_timeout,
        wmpf_debugger_dir=wmpf_debugger_dir,
        status_callback=status_callback,
    )
