"use strict";

const frida = require("frida");
const pid = Number(process.argv[2]);
if (!Number.isInteger(pid)) throw new Error("usage: node tools/inspect-xweb-use-ws.js <wmpf-root-pid>");

(async () => {
    const session = await (await frida.getLocalDevice()).attach(pid);
    const script = await session.createScript(`
        "use strict";
        const module = Process.getModuleByName("flue.dll");
        const getManager = new NativeFunction(module.base.add(0x26b2ec0), "pointer", []);
        const readString = (value) => {
            const marker = value.add(0x17).readS8();
            const length = marker >= 0 ? marker : value.add(8).readU64().toNumber();
            const data = marker >= 0 ? value : value.readPointer();
            if (length < 0 || length > 4096 || data.isNull()) return null;
            return data.readUtf8String(length);
        };
        const manager = getManager();
        const ws = manager;
        let key = null;
        let token = null;
        try { key = readString(ws.add(0x88)); } catch (_) {}
        try { token = readString(ws.add(0xc8)); } catch (_) {}
        send({
            event: "xweb_use_ws_state",
            pid: Process.id,
            flueBase: module.base.toString(),
            manager: manager.toString(),
            ws: ws.toString(),
            key,
            token,
            port: ws.add(0xe0).readU16(),
            state: ws.add(0xe4).readU32(),
            initialized: ws.add(0xe8).readU8(),
            service: ws.add(0xb0).readPointer().toString(),
        });
    `);
    script.message.connect((message) => console.log(JSON.stringify(message.type === "send" ? message.payload : message)));
    await script.load();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await session.detach();
})().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
});
