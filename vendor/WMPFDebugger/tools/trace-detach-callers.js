"use strict";

const fs = require("fs");
const frida = require("frida");

const pid = Number(process.argv[2]);
const output = process.argv[3];
if (!Number.isInteger(pid) || !output) {
    throw new Error("usage: node tools/trace-detach-callers.js <pid> <output.jsonl>");
}

const offsets = [0x2807fc0, 0x2818f50, 0x2818c00, 0x281a000, 0x2af34c0, 0x3e679e0];
const append = (value) => {
    const line = JSON.stringify(value);
    fs.appendFileSync(output, line + "\n", "utf8");
    process.stdout.write(line + "\n");
};

(async () => {
    fs.writeFileSync(output, "", "utf8");
    const session = await (await frida.getLocalDevice()).attach(pid);
    const script = await session.createScript(`
        "use strict";
        const offsets = ${JSON.stringify(offsets)};
        const base = Process.getModuleByName("flue.dll").base;
        const targetThread = 23612;
        function p(v) { try { return v.toString(); } catch (_) { return null; } }
        function bt(ctx) { try { return Thread.backtrace(ctx, Backtracer.ACCURATE).map(DebugSymbol.fromAddress).map(String); } catch (e) { return [String(e)]; } }
        for (const offset of offsets) {
            Interceptor.attach(base.add(offset), {
                onEnter(args) {
                    const tid = Process.getCurrentThreadId();
                    if (offset === 0x3e679e0 && tid !== targetThread) return;
                    this.hit = true;
                    send({event:"enter",offset:"0x"+offset.toString(16),threadId:tid,args:[0,1,2,3,4,5,6,7].map(i=>p(args[i])),registers:{rcx:p(this.context.rcx),rdx:p(this.context.rdx),r8:p(this.context.r8),r9:p(this.context.r9),rsp:p(this.context.rsp)},backtrace:bt(this.context)});
                },
                onLeave(retval) { if (this.hit) send({event:"leave",offset:"0x"+offset.toString(16),threadId:Process.getCurrentThreadId(),retval:p(retval)}); }
            });
        }
        send({event:"ready",pid:Process.id,base:base.toString(),offsets});
    `);
    script.message.connect((message) => append(message.type === "send" ? message.payload : {event:"error",message}));
    await script.load();
    process.on("SIGINT", async () => { try { await session.detach(); } catch (_) {} process.exit(0); });
    await new Promise(() => {});
})().catch((e) => { append({event:"controller_error",error:e.stack||String(e)}); process.exitCode=1; });
