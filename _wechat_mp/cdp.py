from __future__ import annotations

import asyncio
import json
from contextlib import suppress
from typing import Any

from websockets.asyncio.client import ClientConnection, connect as ws_connect


class CdpError(RuntimeError):
    """Raised when the WMPF CDP bridge rejects or times out a request."""


class CdpConnection:
    """Small CDP client supporting flattened target sessions."""

    def __init__(self, url: str, *, timeout: float = 35.0) -> None:
        self.url = url
        self.timeout = timeout
        self.socket: ClientConnection | None = None
        self.reader: asyncio.Task[None] | None = None
        self.next_id = 1
        self.pending: dict[int, asyncio.Future[dict[str, Any]]] = {}

    async def open(self) -> CdpConnection:
        if self.socket is None:
            self.socket = await ws_connect(self.url, max_size=None)
            self.reader = asyncio.create_task(self._read())
        return self

    async def close(self) -> None:
        if self.socket is not None:
            await self.socket.close()
            self.socket = None
        if self.reader is not None:
            self.reader.cancel()
            with suppress(asyncio.CancelledError):
                await self.reader
            self.reader = None
        for future in self.pending.values():
            if not future.done():
                future.set_exception(CdpError("CDP connection closed"))
        self.pending.clear()

    async def __aenter__(self) -> CdpConnection:
        return await self.open()

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def _read(self) -> None:
        assert self.socket is not None
        try:
            async for raw in self.socket:
                message = json.loads(raw)
                request_id = message.get("id")
                if not isinstance(request_id, int):
                    continue
                future = self.pending.get(request_id)
                if future is not None and not future.done():
                    future.set_result(message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(CdpError(f"CDP reader failed: {exc}"))

    async def call(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        session_id: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        if self.socket is None:
            raise CdpError("CDP connection is not open")
        request_id = self.next_id
        self.next_id += 1
        message: dict[str, Any] = {
            "id": request_id,
            "method": method,
            "params": params or {},
        }
        if session_id:
            message["sessionId"] = session_id
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        await self.socket.send(json.dumps(message, ensure_ascii=False))
        try:
            try:
                response = await asyncio.wait_for(future, timeout or self.timeout)
            except TimeoutError as exc:
                raise CdpError(f"CDP {method} timed out") from exc
        finally:
            self.pending.pop(request_id, None)
        if response.get("error"):
            raise CdpError(f"CDP {method} failed: {response['error']}")
        return dict(response.get("result") or {})

    async def targets(self) -> list[dict[str, Any]]:
        result = await self.call("Target.getTargets")
        return list(result.get("targetInfos") or [])

    async def attach(self, target_id: str) -> str:
        result = await self.call(
            "Target.attachToTarget",
            {"targetId": target_id, "flatten": True},
        )
        session_id = str(result.get("sessionId") or "")
        if not session_id:
            raise CdpError("Target.attachToTarget returned no sessionId")
        return session_id

    async def evaluate_json(
        self,
        session_id: str,
        expression: str,
        *,
        timeout: float = 40.0,
    ) -> dict[str, Any]:
        result = await self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "awaitPromise": True,
                "returnByValue": True,
            },
            session_id=session_id,
            timeout=timeout,
        )
        if result.get("exceptionDetails"):
            raise CdpError(f"JavaScript failed: {result['exceptionDetails']}")
        remote = result.get("result") or {}
        value = remote.get("value")
        if not isinstance(value, str):
            raise CdpError(f"JavaScript did not return JSON text: {remote}")
        payload = json.loads(value)
        if not isinstance(payload, dict):
            raise CdpError("JavaScript returned non-object JSON")
        return payload
