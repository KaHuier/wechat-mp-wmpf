"use strict";

const frida = require("frida");
const pid = Number(process.argv[2]);
if (!Number.isInteger(pid)) throw new Error("usage: node tools/locate-xweb-use-manager.js <wmpf-root-pid>");

(async () => {
    const session = await (await frida.getLocalDevice()).attach(pid);
    const source = `
        "use strict";
        const module = Process.getModuleByName("flue.dll");
        const key = "xweb_use_enable_ws_server";
        const keyPattern = Array.from(key)
            .map((char) => char.charCodeAt(0).toString(16).padStart(2, "0"))
            .join(" ");
        const readable = Process.enumerateRanges("rw-");
        const heapStrings = [];
        for (const range of readable) {
            try {
                for (const match of Memory.scanSync(range.base, range.size, keyPattern)) {
                    if (match.address.compare(module.base) < 0 || match.address.compare(module.base.add(module.size)) >= 0) {
                        heapStrings.push(match.address);
                    }
                }
            } catch (_) {}
        }
        const candidates = [];
        for (const stringAddress of heapStrings) {
            const pointerPattern = stringAddress.toMatchPattern();
            for (const range of readable) {
                try {
                    for (const match of Memory.scanSync(range.base, range.size, pointerPattern)) {
                        const object = match.address.sub(0x88);
                        try {
                            const storedPointer = object.add(0x88).readPointer();
                            const length = object.add(0x90).readU64().toNumber();
                            const state = object.add(0xe4).readU32();
                            const initialized = object.add(0xe8).readU8();
                            const token = object.add(0xf0).readPointer();
                            if (storedPointer.equals(stringAddress) && length === key.length && state <= 3 && !token.isNull()) {
                                candidates.push({
                                    object: object.toString(),
                                    stringAddress: stringAddress.toString(),
                                    length,
                                    state,
                                    initialized,
                                    token: token.toString(),
                                    service: object.add(0xb0).readPointer().toString(),
                                });
                            }
                        } catch (_) {}
                    }
                } catch (_) {}
            }
        }
        send({
            event: "xweb_use_candidates",
            pid: Process.id,
            flueBase: module.base.toString(),
            heapStrings: heapStrings.map(String),
            candidates,
        });
    `;
    const script = await session.createScript(source);
    script.message.connect((message) => {
        if (message.type === "send") console.log(JSON.stringify(message.payload));
        else console.error(JSON.stringify(message));
    });
    await script.load();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await session.detach();
})().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
});
