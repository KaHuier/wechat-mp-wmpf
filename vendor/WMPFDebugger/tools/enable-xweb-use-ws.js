"use strict";

const frida = require("frida");
const pid = Number(process.argv[2]);
const threadId = Number(process.argv[3]);
const timeoutMs = Number(process.argv[4] || 15000);
if (!Number.isInteger(pid) || !Number.isInteger(threadId)) {
    throw new Error("usage: node tools/enable-xweb-use-ws.js <wmpf-root-pid> <ui-thread-id> [timeout-ms]");
}

(async () => {
    const session = await (await frida.getLocalDevice()).attach(pid);
    let finished = false;
    let timer;
    const source = `
        "use strict";
        const expectedThreadId = ${threadId};
        const module = Process.getModuleByName("flue.dll");
        const getManager = new NativeFunction(module.base.add(0x26b2ec0), "pointer", []);
        const getDebugSetting = new NativeFunction(module.base.add(0x26b3e90), "uchar", ["pointer", "pointer"]);
        const setDebugSetting = new NativeFunction(module.base.add(0x26b40b0), "void", ["pointer", "pointer", "uchar", "pointer"]);
        const dispatchPoint = module.base.add(0x3e679e0);
        const keyText = "xweb_use_enable_ws_server";
        const keyBuffer = Memory.allocUtf8String(keyText);
        const key = Memory.alloc(0x20);
        key.writeByteArray(new Uint8Array(0x20));
        key.writePointer(keyBuffer);
        key.add(8).writeU64(keyText.length);
        key.add(16).writeU64(uint64("0x8000000000000020"));
        const emptyRef = Memory.alloc(Process.pointerSize);
        emptyRef.writePointer(NULL);
        const readString = (value) => {
            const marker = value.add(0x17).readS8();
            const length = marker >= 0 ? marker : value.add(8).readU64().toNumber();
            const data = marker >= 0 ? value : value.readPointer();
            if (length < 0 || length > 4096 || data.isNull()) return null;
            return data.readUtf8String(length);
        };
        const reportReady = (manager, status) => {
            const state = manager.add(0xe4).readU32();
            const port = manager.add(0xe0).readU16();
            const token = readString(manager.add(0xc8));
            if (state !== 2 || port === 0 || !token) return false;
            send({
                event: "completed",
                status,
                state,
                port,
                token,
                endpoint: "ws://127.0.0.1:" + port + "/xweb-use/v1?token=" + token,
            });
            return true;
        };
        let pending = true;

        Interceptor.attach(dispatchPoint, {
            onEnter() {
                if (!pending || Process.getCurrentThreadId() !== expectedThreadId) return;
                pending = false;
                try {
                    const manager = getManager();
                    const before = getDebugSetting(manager, key);
                    if (reportReady(manager, "already_enabled")) return;
                    send({
                        event: "xweb_use_ws_enable_start",
                        pid: Process.id,
                        threadId: Process.getCurrentThreadId(),
                        flueBase: module.base.toString(),
                        manager: manager.toString(),
                        key: keyText,
                        before,
                    });
                    setDebugSetting(manager, key, 1, emptyRef);
                    const after = getDebugSetting(manager, key);
                    send({
                        event: "xweb_use_ws_enable_return",
                        pid: Process.id,
                        threadId: Process.getCurrentThreadId(),
                        key: keyText,
                        before,
                        after,
                    });
                    let checks = 0;
                    const poll = setInterval(() => {
                        checks += 1;
                        try {
                            if (reportReady(manager, "enabled")) {
                                clearInterval(poll);
                            } else if (checks >= 100) {
                                clearInterval(poll);
                                send({
                                    event: "xweb_use_ws_enable_error",
                                    error: "server did not reach ready state",
                                    state: manager.add(0xe4).readU32(),
                                    port: manager.add(0xe0).readU16(),
                                });
                            }
                        } catch (error) {
                            clearInterval(poll);
                            send({ event: "xweb_use_ws_enable_error", error: String(error) });
                        }
                    }, 50);
                } catch (error) {
                    send({ event: "xweb_use_ws_enable_error", error: String(error), stack: error.stack || "" });
                }
            },
        });
        send({ event: "hook_ready", pid: Process.id, expectedThreadId, dispatchPoint: dispatchPoint.toString() });
    `;
    const script = await session.createScript(source);
    const complete = async (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { await session.detach(); } catch (_) {}
        process.exitCode = code;
    };
    script.message.connect((message) => {
        const payload = message.type === "send" ? message.payload : { event: "frida_error", message };
        process.stdout.write(JSON.stringify(payload) + "\n");
        if (payload.event === "completed") complete(0).catch(console.error);
        if (payload.event === "xweb_use_ws_enable_error" || payload.event === "frida_error") complete(1).catch(console.error);
    });
    timer = setTimeout(() => {
        process.stdout.write(JSON.stringify({ event: "timeout", timeoutMs, threadId }) + "\n");
        complete(2).catch(console.error);
    }, timeoutMs);
    await script.load();
    while (!finished) await new Promise((resolve) => setTimeout(resolve, 50));
})().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
});
