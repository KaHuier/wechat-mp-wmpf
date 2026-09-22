"use strict";

const fs = require("fs");
const frida = require("frida");
const { spawn } = require("child_process");

const pid = Number(process.argv[2]);
const output = process.argv[3];
const uri = process.argv[4];
const timeoutMs = Number(process.argv[5] || 15000);
if (!Number.isInteger(pid) || !output || !uri) {
    throw new Error("usage: node tools/trace-search-window-construction.js <pid> <output.jsonl> <weixin-uri> [timeout-ms]");
}

const offsets = [
    0x2807560,
    0x2807fc0,
    0x280f970,
    0x2810790,
    0x2818c00,
    0x2818f50,
    0x2a63af0,
    0x2a6d610,
    0x2aec4c0,
    0x2af34c0,
];

function append(value) {
    const line = JSON.stringify(value);
    fs.appendFileSync(output, line + "\n", "utf8");
    process.stdout.write(line + "\n");
}

const source = `
"use strict";
const offsets = ${JSON.stringify(offsets)};
function p(v) { try { return v.toString(); } catch (_) { return null; } }
const module = Process.getModuleByName("flue.dll");
for (const offset of offsets) {
    Interceptor.attach(module.base.add(offset), {
        onEnter(args) {
            this.offset = offset;
            this.threadId = Process.getCurrentThreadId();
            this.args = [0,1,2,3,4,5,6,7].map((i) => p(args[i]));
            let stack = [];
            try {
                stack = Thread.backtrace(this.context, Backtracer.ACCURATE)
                    .slice(0, 12)
                    .map((address) => DebugSymbol.fromAddress(address).toString());
            } catch (_) {}
            send({event:"enter", pid:Process.id, base:module.base.toString(), offset:"0x"+offset.toString(16), threadId:this.threadId, args:this.args, stack});
        },
        onLeave(retval) {
            send({event:"leave", pid:Process.id, offset:"0x"+this.offset.toString(16), threadId:this.threadId, args:this.args, retval:p(retval)});
        },
    });
}
send({event:"hooks_ready", pid:Process.id, base:module.base.toString(), offsets});
`;

(async () => {
    fs.writeFileSync(output, "", "utf8");
    const device = await frida.getLocalDevice();
    const session = await device.attach(pid);
    const script = await session.createScript(source);
    script.message.connect((message) => append(message.type === "send" ? message.payload : { event: "frida_error", message }));
    session.detached.connect((reason) => append({ event: "session_detached", reason }));
    await script.load();

    const ps = spawn("powershell.exe", ["-NoProfile", "-Command", `Start-Process ${JSON.stringify(uri)}`], {
        windowsHide: true,
        stdio: "ignore",
    });
    ps.unref();
    append({ event: "uri_launched", uri });

    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    await session.detach();
    append({ event: "completed", status: "ok", timeoutMs });
})().catch((error) => {
    append({ event: "controller_error", error: error.stack || String(error) });
    process.exitCode = 1;
});
