"use strict";

const frida = require("frida");

const pid = Number(process.argv[2]);
const offset = Number(process.argv[3]);
const count = Number(process.argv[4] || 160);
const includeDetails = process.argv[5] === "details";

if (!Number.isInteger(pid) || !Number.isInteger(offset)) {
    throw new Error("usage: node tools/dump-instructions.js <pid> <offset> [count]");
}

(async () => {
    const device = await frida.getLocalDevice();
    const session = await device.attach(pid);
    const source = `
        const module = Process.getModuleByName("flue.dll");
        let cursor = module.base.add(${offset});
        const rows = [];
        for (let index = 0; index < ${count}; index++) {
            const instruction = Instruction.parse(cursor);
            let referencedString = null;
            for (const operand of instruction.operands) {
                if (
                    operand.type !== "mem" ||
                    operand.value.base !== "rip"
                ) continue;
                try {
                    const target = instruction.next.add(operand.value.disp);
                    const candidate = target.readUtf8String(240);
                    if (
                        candidate &&
                        candidate.length >= 4 &&
                        /^[\\x20-\\x7e\\r\\n\\t]+$/.test(candidate)
                    ) {
                        referencedString = candidate;
                    }
                } catch (_) {}
            }
            rows.push({
                offset: cursor.sub(module.base).toString(),
                mnemonic: instruction.mnemonic,
                operands: instruction.opStr,
                operandDetails: instruction.operands,
                referencedString,
            });
            cursor = instruction.next;
        }
        send(rows);
    `;
    const script = await session.createScript(source);
    script.message.connect((message) => {
        if (message.type === "error") {
            console.error(message.stack || message.description);
            return;
        }
        for (const row of message.payload) {
            console.log(
                `${row.offset} ${row.mnemonic} ${row.operands}` +
                    (row.referencedString
                        ? ` ; ${JSON.stringify(row.referencedString)}`
                        : "") +
                    (includeDetails
                        ? ` ; operands=${JSON.stringify(row.operandDetails)}`
                        : ""),
            );
        }
    });
    await script.load();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await session.detach();
})();
