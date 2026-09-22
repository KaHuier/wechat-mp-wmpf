"use strict";

const { execFile } = require("child_process");
const frida = require("frida");

const mainPid = Number(process.argv[2]);
const uri = process.argv[3] || "weixin://resourceid/Search/app.html?isHomePage=1&lang=zh_CN&scene=243&type=0&query=%E6%B5%8B%E8%AF%95%E8%AE%BA%E9%81%93";
if (!Number.isInteger(mainPid)) throw new Error("usage: node gated-wmpf-search.js <weixin-main-pid> [uri]");

const runPowerShell = (command) => new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-Command", command], (error, stdout, stderr) => {
        if (stdout.trim()) console.log(JSON.stringify({ event: "powershell", stdout: stdout.trim() }));
        if (stderr.trim()) console.error(stderr.trim());
        error ? reject(error) : resolve();
    });
});

const rootSource = `
    "use strict";
    const suffix = " --no-sandbox --disable-gpu-sandbox";
    const hooked = new Set();
    function attach(moduleName, exportName, index) {
        let address;
        try { address = Process.getModuleByName(moduleName).getExportByName(exportName); }
        catch (_) { return; }
        if (hooked.has(address.toString())) return;
        hooked.add(address.toString());
        Interceptor.attach(address, { onEnter(args) {
            let commandLine;
            try { commandLine = args[index].readUtf16String(); } catch (_) { return; }
            if (!commandLine || !commandLine.includes("--type=renderer") || !commandLine.includes("--wmpf-render-type=7") || commandLine.includes("--no-sandbox")) return;
            const replacement = Memory.allocUtf16String(commandLine + suffix);
            this.replacement = replacement;
            const registers = ["rcx", "rdx", "r8", "r9"];
            if (Process.arch === "x64" && index < registers.length) this.context[registers[index]] = replacement;
            else args[index] = replacement;
            send({ event: "search_command_line_patched", commandLine: commandLine + suffix });
        }});
    }
    attach("KernelBase.dll", "CreateProcessW", 1);
    attach("KernelBase.dll", "CreateProcessInternalW", 2);
    attach("kernel32.dll", "CreateProcessW", 1);
    send({ event: "root_hook_ready", pid: Process.id, hooks: hooked.size });
`;

const childSource = `
    "use strict";
    const seen = new Set();
    function report(path) {
        if (!path || seen.has(path)) return;
        const lower = path.toLowerCase();
        if (!lower.includes("xworker\\\\search") && !lower.endsWith(".js") && !lower.includes("code cache")) return;
        seen.add(path); send({ event: "file", pid: Process.id, path });
    }
    for (const moduleName of ["kernelbase.dll", "kernel32.dll"]) {
        let module; try { module = Process.getModuleByName(moduleName); } catch (_) { continue; }
        const address = module.findExportByName("CreateFileW");
        if (address !== null) Interceptor.attach(address, { onEnter(args) { try { report(args[0].readUtf16String()); } catch (_) {} }});
    }
    send({ event: "child_ready", pid: Process.id });
`;

(async () => {
    const device = await frida.getLocalDevice();
    const mainSession = await device.attach(mainPid);
    await mainSession.enableChildGating();
    let rootPid = null;
    let rootSession = null;
    let rootScript = null;
    const childSessions = [];
    let searchStarted = false;

    device.childAdded.connect(async (child) => {
        console.log(JSON.stringify({ event: "child_added", pid: child.pid, parentPid: child.parentPid, identifier: child.identifier }));
        if (child.parentPid === mainPid && rootPid === null) {
            try {
                rootPid = child.pid;
                rootSession = await device.attach(child.pid);
                rootScript = await rootSession.createScript(rootSource);
                rootScript.message.connect((message) => console.log(JSON.stringify(message.type === "send" ? message.payload : message)));
                await rootScript.load();
                await rootSession.enableChildGating();
                console.log(JSON.stringify({ event: "root_ready", rootPid }));
            } catch (error) {
                console.error(JSON.stringify({ event: "root_error", error: String(error) }));
            } finally {
                await device.resume(child.pid);
            }
            if (!searchStarted) {
                searchStarted = true;
                setTimeout(() => runPowerShell(`Start-Process '${uri.replaceAll("'", "''")}'`).catch(console.error), 2500);
            }
            return;
        }
        if (rootPid !== null && child.parentPid === rootPid) {
            try {
                const session = await device.attach(child.pid);
                const script = await session.createScript(childSource);
                script.message.connect((message) => console.log(JSON.stringify(message.type === "send" ? message.payload : message)));
                await script.load();
                childSessions.push(session);
            } catch (error) {
                console.error(JSON.stringify({ event: "child_hook_error", pid: child.pid, error: String(error) }));
            } finally {
                await device.resume(child.pid);
            }
            return;
        }
        await device.resume(child.pid);
    });

    console.log(JSON.stringify({ event: "main_gating_ready", mainPid }));
    await runPowerShell(`Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'WeChatAppEx.exe' -and $_.ParentProcessId -eq ${mainPid}} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force}`);
    await new Promise((resolve) => setTimeout(resolve, 25000));
    console.log(JSON.stringify({ event: "complete", rootPid, children: childSessions.length }));
    for (const session of childSessions) { try { await session.detach(); } catch (_) {} }
    if (rootSession) { try { await rootSession.disableChildGating(); } catch (_) {} }
    if (rootScript) { try { await rootScript.unload(); } catch (_) {} }
    if (rootSession) { try { await rootSession.detach(); } catch (_) {} }
    await mainSession.disableChildGating();
    await mainSession.detach();
})().catch((error) => { console.error(error.stack || String(error)); process.exitCode = 1; });
