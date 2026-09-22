"use strict";

const { execFile } = require("child_process");
const fs = require("fs");
const frida = require("frida");

const mainPid = Number(process.argv[2]);
const output = process.argv[3];
const timeoutMs = Number(process.argv[4] || 18000);
if (!Number.isInteger(mainPid) || !output) {
    throw new Error("usage: node tools/trace-gated-wmpf-restart.js <weixin-main-pid> <output.jsonl> [timeout-ms]");
}

const offsets = [0x2807560, 0x2807fc0, 0x280f970, 0x2810790, 0x2818c00, 0x2818f50, 0x2a63af0, 0x2a6d610, 0x2aec4c0, 0x2af34c0];
function append(value) {
    const line = JSON.stringify(value);
    fs.appendFileSync(output, line + "\n", "utf8");
    process.stdout.write(line + "\n");
}
const runPowerShell = (command) => new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-Command", command], (error, stdout, stderr) => {
        if (stdout.trim()) append({ event: "powershell", stdout: stdout.trim() });
        if (stderr.trim()) append({ event: "powershell_stderr", stderr: stderr.trim() });
        error ? reject(error) : resolve();
    });
});

const source = `
"use strict";
const offsets = ${JSON.stringify(offsets)};
function p(v) { try { return v.toString(); } catch (_) { return null; } }
function install() {
    const module = Process.findModuleByName("flue.dll");
    if (module === null) { setTimeout(install, 5); return; }
    for (const offset of offsets) {
        Interceptor.attach(module.base.add(offset), {
            onEnter(args) {
                const threadId = Process.getCurrentThreadId();
                const values = [0,1,2,3,4,5,6,7].map((i) => p(args[i]));
                let stack = [];
                try {
                    stack = Thread.backtrace(this.context, Backtracer.ACCURATE).slice(0, 10)
                        .map((a) => DebugSymbol.fromAddress(a).toString());
                } catch (_) {}
                send({event:"enter",pid:Process.id,base:module.base.toString(),offset:"0x"+offset.toString(16),threadId,args:values,stack});
            },
            onLeave(retval) {
                send({event:"leave",pid:Process.id,offset:"0x"+offset.toString(16),threadId:Process.getCurrentThreadId(),retval:p(retval)});
            },
        });
    }
    send({event:"hooks_ready",pid:Process.id,base:module.base.toString(),offsets});
}
install();
`;

(async () => {
    fs.writeFileSync(output, "", "utf8");
    const device = await frida.getLocalDevice();
    const mainSession = await device.attach(mainPid);
    await mainSession.enableChildGating();
    let rootPid = null;
    let rootSession = null;
    let rootScript = null;
    let resolveRoot;
    const rootReady = new Promise((resolve) => { resolveRoot = resolve; });

    device.childAdded.connect(async (child) => {
        append({ event: "child_added", pid: child.pid, parentPid: child.parentPid, identifier: child.identifier });
        if (child.parentPid !== mainPid || rootPid !== null) {
            await device.resume(child.pid);
            return;
        }
        rootPid = child.pid;
        try {
            rootSession = await device.attach(child.pid);
            rootScript = await rootSession.createScript(source);
            rootScript.message.connect((message) => append(message.type === "send" ? message.payload : { event: "frida_error", message }));
            await rootScript.load();
            append({ event: "root_instrumented", rootPid });
        } catch (error) {
            append({ event: "root_instrument_error", rootPid, error: error.stack || String(error) });
        } finally {
            await device.resume(child.pid);
            resolveRoot(rootPid);
        }
    });

    append({ event: "main_gating_ready", mainPid });
    const command = `Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'WeChatAppEx.exe' -and $_.ParentProcessId -eq ${mainPid}} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force}`;
    await runPowerShell(command);
    await Promise.race([
        rootReady,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for gated WMPF root")), 10000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    append({ event: "completed", status: "ok", mainPid, rootPid, timeoutMs });

    if (rootScript) { try { await rootScript.unload(); } catch (_) {} }
    if (rootSession) { try { await rootSession.detach(); } catch (_) {} }
    await mainSession.disableChildGating();
    await mainSession.detach();
    process.exit(0);
})().catch((error) => {
    append({ event: "controller_error", error: error.stack || String(error) });
    process.exit(1);
});
