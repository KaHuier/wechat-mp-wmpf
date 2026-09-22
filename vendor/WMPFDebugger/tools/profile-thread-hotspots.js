"use strict";
const frida = require("frida");
const pid = Number(process.argv[2]);
const seconds = Number(process.argv[3] || 5);
const offsets = [
    0x2818f50, 0x2c45f10, 0x4b5c210, 0x431fdf0, 0x53fd210,
    0x35c5970, 0x271650, 0x70100, 0x70090, 0x3e679e0,
    0x3d3e460, 0x74000, 0x515f420, 0xcdcb40,
];
(async () => {
    const session = await (await frida.getLocalDevice()).attach(pid);
    const script = await session.createScript(`
        const offsets = ${JSON.stringify(offsets)};
        const counts = {};
        const base = Process.getModuleByName("flue.dll").base;
        for (const offset of offsets) {
            Interceptor.attach(base.add(offset), { onEnter() {
                const key = "0x" + offset.toString(16) + ":" + Process.getCurrentThreadId();
                counts[key] = (counts[key] || 0) + 1;
            }});
        }
        setTimeout(() => send(counts), ${seconds * 1000});
    `);
    const done = new Promise((resolve) => script.message.connect((message) => {
        if (message.type === "send") { console.log(JSON.stringify(message.payload, null, 2)); resolve(); }
    }));
    await script.load(); await done; await session.detach();
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
