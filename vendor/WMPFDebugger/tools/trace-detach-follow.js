"use strict";

const fs = require("fs");
const frida = require("frida");

const mainPid = Number(process.argv[2]);
const output = process.argv[3];
if (!Number.isInteger(mainPid) || !output) {
    throw new Error("usage: node tools/trace-detach-follow.js <weixin-main-pid> <output.jsonl>");
}

const offsets = [0x2807fc0, 0x2818c00, 0x2818f50, 0x281a000, 0x2aeecf0, 0x2af2e50, 0x2af34c0];
const sessions = new Map();
const append = (value) => {
    const line = JSON.stringify(value);
    fs.appendFileSync(output, line + "\n", "utf8");
    process.stdout.write(line + "\n");
};

const source = `
"use strict";
const offsets = ${JSON.stringify(offsets)};
function p(v) { try { return v.toString(); } catch (_) { return null; } }
function install() {
  const module = Process.findModuleByName("flue.dll");
  if (module === null) { setTimeout(install, 20); return; }
  for (const offset of offsets) {
    Interceptor.attach(module.base.add(offset), {
      onEnter(args) {
        this.hit = true;
        send({event:"enter",pid:Process.id,base:module.base.toString(),offset:"0x"+offset.toString(16),threadId:Process.getCurrentThreadId(),args:[0,1,2,3,4,5,6,7].map(i=>p(args[i])),registers:{rcx:p(this.context.rcx),rdx:p(this.context.rdx),r8:p(this.context.r8),r9:p(this.context.r9),rsp:p(this.context.rsp)}});
      },
      onLeave(retval) { if (this.hit) send({event:"leave",pid:Process.id,offset:"0x"+offset.toString(16),threadId:Process.getCurrentThreadId(),retval:p(retval)}); }
    });
  }
  send({event:"hooks_ready",pid:Process.id,base:module.base.toString(),offsets});
}
install();
`;

(async () => {
    fs.writeFileSync(output, "", "utf8");
    const device = await frida.getLocalDevice();
    const attachRoots = async () => {
        const processes = await device.enumerateProcesses({ scope: frida.Scope.Metadata });
        const roots = processes.filter((p) => p.name === "WeChatAppEx.exe" && Number(p.parameters.ppid) === mainPid);
        for (const root of roots) {
            if (sessions.has(root.pid)) continue;
            try {
                const session = await device.attach(root.pid);
                const script = await session.createScript(source);
                script.message.connect((message) => append(message.type === "send" ? message.payload : {event:"frida_error",pid:root.pid,message}));
                session.detached.connect((reason) => { append({event:"detached",pid:root.pid,reason}); sessions.delete(root.pid); });
                await script.load();
                sessions.set(root.pid, {session, script});
                append({event:"attached",pid:root.pid});
            } catch (error) {
                append({event:"attach_error",pid:root.pid,error:String(error)});
            }
        }
    };
    await attachRoots();
    const timer = setInterval(() => attachRoots().catch((e) => append({event:"poll_error",error:String(e)})), 250);
    process.on("SIGINT", async () => {
        clearInterval(timer);
        for (const {session} of sessions.values()) { try { await session.detach(); } catch (_) {} }
        process.exit(0);
    });
    await new Promise(() => {});
})().catch((e) => { append({event:"controller_error",error:e.stack||String(e)}); process.exitCode=1; });
