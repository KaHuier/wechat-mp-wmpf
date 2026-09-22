"use strict";

const frida = require("frida");

const pid = Number(process.argv[2]);
const threadId = Number(process.argv[3]);
const objectPointer = process.argv[4];
const packedX = process.argv[5] || "0x100000354";
const packedY = process.argv[6] || "0x1000000c5";

if (!Number.isInteger(pid) || !Number.isInteger(threadId) || !objectPointer) {
    throw new Error(
        "usage: node tools/dispatch-discovery-detach.js <pid> <ui-thread-id> <object-pointer> [packed-x] [packed-y]",
    );
}

(async () => {
    const device = await frida.getLocalDevice();
    const session = await device.attach(pid);
    const source = `
        "use strict";
        const CUSTOM_MESSAGE = 0xB7D1;
        const targetThread = ${threadId};
        let pending = false;

        const flue = Process.getModuleByName("flue.dll");
        const user32 = Process.getModuleByName("user32.dll");
        const detach = new NativeFunction(
            flue.base.add(0x2af34c0),
            "pointer",
            ["pointer", "uint64", "uint64"],
        );
        const postThreadMessage = new NativeFunction(
            user32.getExportByName("PostThreadMessageW"),
            "bool",
            ["uint32", "uint32", "pointer", "pointer"],
        );

        // 0x3e679e0 is the flue task-sequence trampoline observed in the
        // detach call stack. It runs repeatedly on the same sequence thread,
        // so it gives the native method the required thread affinity without
        // UI input, UIA, screenshots, or Process.runOnThread.
        Interceptor.attach(flue.base.add(0x3e679e0), {
            onEnter() {
                if (!pending || Process.getCurrentThreadId() !== targetThread) return;
                pending = false;
                try {
                    const result = detach(
                        ptr(${JSON.stringify(objectPointer)}),
                        uint64(${JSON.stringify(packedX)}),
                        uint64(${JSON.stringify(packedY)}),
                    );
                    send({ event: "detached", threadId: Process.getCurrentThreadId(), result: result.toString() });
                } catch (error) {
                    send({ event: "detach_error", error: String(error), stack: error.stack || null });
                }
            },
        });

        rpc.exports.invoke = function () {
            pending = true;
            // The post wakes the sequence promptly; the trampoline hook above
            // performs the call only after execution is back on targetThread.
            postThreadMessage(targetThread, CUSTOM_MESSAGE, ptr(0), ptr(0));
            return true;
        };
    `;
    const script = await session.createScript(source);
    let finish;
    const completed = new Promise((resolve) => { finish = resolve; });
    script.message.connect((message) => {
        if (message.type === "send") {
            console.log(JSON.stringify(message.payload));
            if (message.payload.event === "detached" || message.payload.event === "detach_error") finish();
        } else {
            console.error(JSON.stringify(message));
            finish();
        }
    });
    await script.load();
    const posted = await script.exports.invoke();
    console.log(JSON.stringify({ event: "posted", pid, threadId, posted }));
    await Promise.race([
        completed,
        new Promise((_, reject) => setTimeout(() => reject(new Error("detach dispatch timed out")), 10000)),
    ]);
    await session.detach();
})().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
});
