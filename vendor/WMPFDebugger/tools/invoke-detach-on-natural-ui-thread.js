"use strict";

const frida = require("frida");

const pid = Number(process.argv[2]);
const threadId = Number(process.argv[3]);
const objectPointer = process.argv[4];
const packedX = process.argv[5] || "0x1000003e5";
const packedY = process.argv[6] || "0x1000000fb";
const timeoutMs = Number(process.argv[7] || 15000);

if (!Number.isInteger(pid) || !Number.isInteger(threadId) || !objectPointer) {
    throw new Error(
        "usage: node tools/invoke-detach-on-natural-ui-thread.js <pid> <ui-thread-id> <object-pointer> [packed-x] [packed-y] [timeout-ms]",
    );
}

(async () => {
    const device = await frida.getLocalDevice();
    const session = await device.attach(pid);
    let finished = false;

    const source = `
        "use strict";
        const expectedThreadId = ${threadId};
        const module = Process.getModuleByName("flue.dll");
        const dispatchPoint = module.base.add(0x3e679e0);
        const detach = new NativeFunction(
            module.base.add(0x2af34c0),
            "pointer",
            ["pointer", "uint64", "uint64"],
        );
        let pending = true;

        Interceptor.attach(dispatchPoint, {
            onEnter() {
                if (!pending || Process.getCurrentThreadId() !== expectedThreadId) return;
                pending = false;
                const result = detach(
                    ptr(${JSON.stringify(objectPointer)}),
                    uint64(${JSON.stringify(packedX)}),
                    uint64(${JSON.stringify(packedY)}),
                );
                send({
                    event: "natural_ui_thread_detach",
                    pid: Process.id,
                    threadId: Process.getCurrentThreadId(),
                    flueBase: module.base.toString(),
                    dispatchPoint: dispatchPoint.toString(),
                    objectPointer: ${JSON.stringify(objectPointer)},
                    packedX: ${JSON.stringify(packedX)},
                    packedY: ${JSON.stringify(packedY)},
                    result: result.toString(),
                });
            },
        });

        send({
            event: "hook_ready",
            pid: Process.id,
            expectedThreadId,
            flueBase: module.base.toString(),
            dispatchPoint: dispatchPoint.toString(),
        });
    `;

    const script = await session.createScript(source);
    const complete = async (exitCode, payload) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (payload !== undefined) process.stdout.write(JSON.stringify(payload) + "\n");
        try { await session.detach(); } catch (_) {}
        process.exitCode = exitCode;
    };

    script.message.connect((message) => {
        if (message.type === "send") {
            process.stdout.write(JSON.stringify(message.payload) + "\n");
            if (message.payload.event === "natural_ui_thread_detach") {
                complete(0, { event: "completed", status: "ok" }).catch(console.error);
            }
        } else {
            complete(1, { event: "frida_error", message }).catch(console.error);
        }
    });
    session.detached.connect((reason) => {
        if (!finished) {
            finished = true;
            clearTimeout(timer);
            process.stdout.write(JSON.stringify({ event: "session_detached", reason }) + "\n");
            process.exitCode = 1;
        }
    });

    const timer = setTimeout(() => {
        complete(2, { event: "timeout", timeoutMs, expectedThreadId: threadId }).catch(console.error);
    }, timeoutMs);

    await script.load();
    while (!finished) await new Promise((resolve) => setTimeout(resolve, 50));
})().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
});
