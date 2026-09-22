"use strict";

const frida = require("frida");

const pid = Number(process.argv[2]);
const needles = process.argv.slice(3);

if (!Number.isInteger(pid) || needles.length === 0) {
    throw new Error(
        "usage: node tools/find-string-xrefs.js <pid> <ascii-string> [...]",
    );
}

(async () => {
    const device = await frida.getLocalDevice();
    const session = await device.attach(pid);
    const source = `
        "use strict";

        const needles = ${JSON.stringify(needles)};
        const module = Process.getModuleByName("flue.dll");

        const asciiPattern = (value) => Array.from(value)
            .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
            .join(" ");

        const section = module.enumerateSections().find((item) => item.name === ".pdata");
        if (!section) throw new Error(".pdata section not found");
        const bytes = section.address.readByteArray(section.size);
        if (!bytes) throw new Error("unable to read .pdata");
        const view = new DataView(bytes);
        const functions = [];
        for (let offset = 0; offset + 12 <= view.byteLength; offset += 12) {
            const begin = view.getUint32(offset, true);
            const end = view.getUint32(offset + 4, true);
            if (begin !== 0 && begin < end && end <= module.size) {
                functions.push({ begin, end });
            }
        }
        functions.sort((left, right) => left.begin - right.begin);

        const findFunction = (address) => {
            let low = 0;
            let high = functions.length - 1;
            while (low <= high) {
                const middle = (low + high) >>> 1;
                const candidate = functions[middle];
                if (address < candidate.begin) high = middle - 1;
                else if (address >= candidate.end) low = middle + 1;
                else return candidate;
            }
            return null;
        };

        const targets = [];
        const dataSections = module.enumerateSections().filter(
            (item) => item.name !== ".text" && item.name !== ".pdata",
        );
        for (const needle of needles) {
            for (const item of dataSections) {
                try {
                    for (const match of Memory.scanSync(item.address, item.size, asciiPattern(needle))) {
                        let containingStart = match.address;
                        const lowerBound = item.address;
                        for (let count = 0; count < 512 && containingStart.compare(lowerBound) > 0; count++) {
                            if (containingStart.sub(1).readU8() === 0) break;
                            containingStart = containingStart.sub(1);
                        }
                        let containingString = null;
                        try {
                            containingString = containingStart.readUtf8String(1024);
                        } catch (_) {}
                        targets.push({
                            needle,
                            address: match.address,
                            start: match.address.sub(module.base).toUInt32(),
                            end: match.address.sub(module.base).toUInt32() + needle.length,
                            containingString,
                        });
                    }
                } catch (_) {}
            }
        }

        const rows = [];
        const seen = new Set();
        for (const range of module.enumerateRanges("r-x")) {
            for (const prefix of ["48 8d", "4c 8d"]) {
                for (const match of Memory.scanSync(range.base, range.size, prefix)) {
                    const address = match.address;
                    if (address.add(7).compare(range.base.add(range.size)) > 0) continue;
                    if ((address.add(2).readU8() & 0xc7) !== 0x05) continue;
                    const instructionOffset = address.sub(module.base).toUInt32();
                    const targetOffset = instructionOffset + 7 + address.add(3).readS32();
                    for (const target of targets) {
                        if (targetOffset < target.start || targetOffset > target.end) continue;
                        const owner = findFunction(instructionOffset);
                        const key = target.needle + ":" + instructionOffset;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        const instruction = Instruction.parse(address);
                        rows.push({
                            needle: target.needle,
                            stringOffset: "0x" + target.start.toString(16),
                            containingString: target.containingString,
                            instructionOffset: "0x" + instructionOffset.toString(16),
                            instruction: instruction.toString(),
                            functionBegin: owner ? "0x" + owner.begin.toString(16) : null,
                            functionEnd: owner ? "0x" + owner.end.toString(16) : null,
                        });
                    }
                }
            }
        }
        send({ moduleBase: module.base.toString(), targets: targets.length, rows });
    `;

    const script = await session.createScript(source);
    const completed = new Promise((resolve, reject) => {
        script.message.connect((message) => {
            if (message.type === "error") {
                reject(new Error(message.stack || message.description));
                return;
            }
            console.log(JSON.stringify(message.payload, null, 2));
            resolve();
        });
    });
    await script.load();
    await completed;
    await session.detach();
})().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
