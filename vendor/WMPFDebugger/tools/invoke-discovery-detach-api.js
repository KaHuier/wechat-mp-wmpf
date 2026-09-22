"use strict";

const frida = require("frida");

const pid = Number(process.argv[2]);
const threadId = Number(process.argv[3]);
const biz = Number(process.argv[4] || 7);
const timeoutMs = Number(process.argv[5] || 15000);
if (!Number.isInteger(pid) || !Number.isInteger(threadId) || !Number.isInteger(biz)) {
    throw new Error("usage: node tools/invoke-discovery-detach-api.js <wmpf-root-pid> <ui-thread-id> [biz] [timeout-ms]");
}

(async () => {
    const device = await frida.getLocalDevice();
    const session = await device.attach(pid);
    let finished = false;
    let timer;
    const source = `
        "use strict";
        const expectedThreadId = ${threadId};
        const biz = ${biz};
        const module = Process.getModuleByName("flue.dll");
        const valueInit = new NativeFunction(module.base.add(0x3a0860), "pointer", ["pointer", "uchar"]);
        const dictSet = new NativeFunction(module.base.add(0x40813a0), "pointer", ["pointer", "pointer", "pointer"]);
        const invokeNative = new NativeFunction(module.base.add(0x280f190), "void", ["pointer", "pointer", "pointer"]);
        const valueDestroy = new NativeFunction(module.base.add(0x50e4530), "void", ["pointer"]);
        const manager = module.base.add(0xdc1cca0);
        const dispatchPoint = module.base.add(0x3e679e0);
        const methodText = "xweb_call_discovery_detach_button_clicked";
        let pending = true;

        Interceptor.attach(dispatchPoint, {
            onEnter() {
                if (!pending || Process.getCurrentThreadId() !== expectedThreadId) return;
                pending = false;
                let dict = NULL;
                try {
                    dict = Memory.alloc(0x20);
                    dict.writeByteArray(new Uint8Array(0x20));
                    valueInit(dict, 6);

                    const intValue = Memory.alloc(0x20);
                    intValue.writeByteArray(new Uint8Array(0x20));
                    intValue.writeS32(biz);
                    intValue.add(0x18).writeU8(2);

                    const key = Memory.alloc(0x10);
                    key.writePointer(module.base.add(0xbfb052f));
                    key.add(8).writeU64(3);
                    dictSet(dict, key, intValue);

                    const methodBuffer = Memory.allocUtf8String(methodText);
                    const method = Memory.alloc(0x18);
                    method.writeByteArray(new Uint8Array(0x18));
                    method.writePointer(methodBuffer);
                    method.add(8).writeU64(methodText.length);
                    method.add(16).writeU64(uint64("0x8000000000000030"));

                    send({
                        event: "native_api_invoke_start",
                        pid: Process.id,
                        threadId: Process.getCurrentThreadId(),
                        flueBase: module.base.toString(),
                        manager: manager.toString(),
                        method: methodText,
                        biz,
                    });
                    invokeNative(manager, method, dict);
                    send({
                        event: "native_api_invoke_return",
                        pid: Process.id,
                        threadId: Process.getCurrentThreadId(),
                        method: methodText,
                        biz,
                    });
                    valueDestroy(dict);
                    send({ event: "completed", status: "ok", pid: Process.id, threadId: Process.getCurrentThreadId(), biz });
                } catch (error) {
                    send({ event: "native_api_invoke_error", error: String(error), stack: error.stack || "", biz });
                }
            },
        });
        send({ event: "hook_ready", pid: Process.id, expectedThreadId, dispatchPoint: dispatchPoint.toString(), biz });
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
        if (payload.event === "native_api_invoke_error" || payload.event === "frida_error") complete(1).catch(console.error);
    });
    session.detached.connect((reason) => {
        if (!finished) {
            finished = true;
            clearTimeout(timer);
            process.stdout.write(JSON.stringify({ event: "session_detached", reason }) + "\n");
            process.exitCode = 1;
        }
    });
    timer = setTimeout(() => {
        process.stdout.write(JSON.stringify({ event: "timeout", timeoutMs, threadId, biz }) + "\n");
        complete(2).catch(console.error);
    }, timeoutMs);
    await script.load();
    while (!finished) await new Promise((resolve) => setTimeout(resolve, 50));
})().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
});
