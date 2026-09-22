"use strict";

const frida = require("frida");

const pid = Number(process.argv[2]);
const offsets = process.argv.slice(3).map((value) => Number(value));

if (!Number.isInteger(pid) || offsets.length === 0 || offsets.some((value) => !Number.isInteger(value))) {
    throw new Error(
        "usage: node tools/find-pointer-xrefs.js <pid> <module-offset> [...]",
    );
}

(async () => {
    const device = await frida.getLocalDevice();
    const session = await device.attach(pid);
    const source = `
        "use strict";
        const offsets = ${JSON.stringify(offsets)};
        const module = Process.getModuleByName("flue.dll");
        const pointerSize = Process.pointerSize;
        const patternForPointer = (value) => {
            const bytes = [];
            let current = BigInt(value.toString());
            for (let index = 0; index < pointerSize; index++) {
                bytes.push(Number(current & 0xffn).toString(16).padStart(2, "0"));
                current >>= 8n;
            }
            return bytes.join(" ");
        };
        const rows = [];
        const ranges = module.enumerateRanges("r--").concat(module.enumerateRanges("rw-"));
        for (const offset of offsets) {
            const target = module.base.add(offset);
            for (const range of ranges) {
                for (const match of Memory.scanSync(range.base, range.size, patternForPointer(target))) {
                    const entries = [];
                    for (let delta = -0x50; delta <= 0x70; delta += pointerSize) {
                        const slot = match.address.add(delta);
                        let value = null;
                        let moduleOffset = null;
                        try {
                            value = slot.readPointer();
                            if (value.compare(module.base) >= 0 && value.compare(module.base.add(module.size)) < 0) {
                                moduleOffset = "0x" + value.sub(module.base).toString(16);
                            }
                        } catch (_) {}
                        entries.push({ delta, slot: slot.toString(), value: value && value.toString(), moduleOffset });
                    }
                    rows.push({
                        targetOffset: "0x" + offset.toString(16),
                        matchOffset: "0x" + match.address.sub(module.base).toString(16),
                        protection: range.protection,
                        entries,
                    });
                }
            }
        }
        send(rows);
    `;
    const script = await session.createScript(source);
    const completed = new Promise((resolve, reject) => {
        script.message.connect((message) => {
            if (message.type === "error") reject(new Error(message.stack || message.description));
            else {
                console.log(JSON.stringify(message.payload, null, 2));
                resolve();
            }
        });
    });
    await script.load();
    await completed;
    await session.detach();
})().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
