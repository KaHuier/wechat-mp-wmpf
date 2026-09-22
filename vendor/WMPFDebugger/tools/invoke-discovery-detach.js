"use strict";

const frida = require("frida");

const pid = Number(process.argv[2]);
const threadId = Number(process.argv[3]);
const objectPointer = process.argv[4];
const packedX = process.argv[5] || "0x100000354";
const packedY = process.argv[6] || "0x1000000c5";

if (!Number.isInteger(pid) || !Number.isInteger(threadId) || !objectPointer) {
    throw new Error(
        "usage: node tools/invoke-discovery-detach.js <pid> <ui-thread-id> <object-pointer> [packed-x] [packed-y]",
    );
}

(async () => {
    const device = await frida.getLocalDevice();
    const session = await device.attach(pid);
    const source = `
        "use strict";
        const module = Process.getModuleByName("flue.dll");
        const detach = new NativeFunction(
            module.base.add(0x2af34c0),
            "pointer",
            ["pointer", "uint64", "uint64"],
        );
        rpc.exports.invoke = function () {
            // flue's detach method posts the renderer/container transition to
            // its own sequence; calling it from the Frida agent thread avoids
            // UI input and does not require a Chromium debugging endpoint.
            const result = detach(
                ptr(${JSON.stringify(objectPointer)}),
                uint64(${JSON.stringify(packedX)}),
                uint64(${JSON.stringify(packedY)}),
            );
            return result.toString();
        };
    `;
    const script = await session.createScript(source);
    script.message.connect((message) => console.error(JSON.stringify(message)));
    await script.load();
    const result = await script.exports.invoke();
    console.log(JSON.stringify({ pid, threadId, objectPointer, packedX, packedY, result }));
    await session.detach();
})().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
});
