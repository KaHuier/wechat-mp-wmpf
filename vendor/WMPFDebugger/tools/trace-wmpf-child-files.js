"use strict";

const { execFile } = require("child_process");
const frida = require("frida");

const rootPid = Number(process.argv[2]);
const uri = process.argv[3] || "weixin://resourceid/Search/app.html?isHomePage=1&lang=zh_CN&scene=243&type=0&query=%E6%B5%8B%E8%AF%95%E8%AE%BA%E9%81%93";
if (!Number.isInteger(rootPid)) throw new Error("usage: node trace-wmpf-child-files.js <root-pid> [uri]");

(async () => {
    const device = await frida.getLocalDevice();
    const rootSession = await device.attach(rootPid);
    const rootScript = await rootSession.createScript(`
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
                send({ event: "command_line_patched", commandLine: commandLine + suffix });
            }});
        }
        attach("KernelBase.dll", "CreateProcessW", 1);
        attach("KernelBase.dll", "CreateProcessInternalW", 2);
        attach("kernel32.dll", "CreateProcessW", 1);
        send({ event: "root_hook_ready", hooks: hooked.size });
    `);
    rootScript.message.connect((message) => {
        if (message.type === "send") console.log(JSON.stringify(message.payload));
        else console.error(JSON.stringify(message));
    });
    await rootScript.load();
    await rootSession.enableChildGating();
    const childSessions = [];
    const hooked = [];

    const childSource = `
        "use strict";
        const seen = new Set();
        function report(path) {
            if (!path || seen.has(path)) return;
            const lower = path.toLowerCase();
            if (!lower.includes("xworker\\\\search") && !lower.endsWith(".js") && !lower.includes("code cache")) return;
            seen.add(path);
            send({ event: "file", pid: Process.id, path });
        }
        function install() {
            for (const moduleName of ["kernelbase.dll", "kernel32.dll"]) {
                let module;
                try { module = Process.getModuleByName(moduleName); } catch (_) { continue; }
                for (const name of ["CreateFileW", "CreateFile2"]) {
                    const address = module.findExportByName(name);
                    if (address === null) continue;
                    Interceptor.attach(address, { onEnter(args) {
                        try { report(args[0].readUtf16String()); } catch (_) {}
                    }});
                }
            }
            send({ event: "child_ready", pid: Process.id });
        }
        install();
    `;

    device.childAdded.connect(async (child) => {
        if (child.parentPid !== rootPid) {
            await device.resume(child.pid);
            return;
        }
        console.log(JSON.stringify({ event: "child_added", pid: child.pid, identifier: child.identifier }));
        try {
            const session = await device.attach(child.pid);
            const script = await session.createScript(childSource);
            script.message.connect((message) => {
                if (message.type === "send") console.log(JSON.stringify(message.payload));
                else console.error(JSON.stringify(message));
            });
            await script.load();
            childSessions.push(session);
            hooked.push(child.pid);
        } catch (error) {
            console.error(JSON.stringify({ event: "child_hook_error", pid: child.pid, error: String(error) }));
        } finally {
            await device.resume(child.pid);
        }
    });

    console.log(JSON.stringify({ event: "gating_ready", rootPid }));
    await new Promise((resolve, reject) => {
        execFile(
            "powershell.exe",
            [
                "-NoProfile",
                "-Command",
                `Get-CimInstance Win32_Process | Where-Object {$_.ParentProcessId -eq ${rootPid} -and $_.Name -eq 'WeChatAppEx.exe' -and $_.CommandLine -match 'wmpf-render-type=7'} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force}`,
            ],
            (error) => error ? reject(error) : resolve(),
        );
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await new Promise((resolve, reject) => {
        execFile(
            "powershell.exe",
            ["-NoProfile", "-Command", `Start-Process '${uri.replaceAll("'", "''")}'`],
            (error) => error ? reject(error) : resolve(),
        );
    });
    await new Promise((resolve) => setTimeout(resolve, 15000));
    console.log(JSON.stringify({ event: "complete", hooked }));
    for (const session of childSessions) {
        try { await session.detach(); } catch (_) {}
    }
    await rootSession.disableChildGating();
    await rootScript.unload();
    await rootSession.detach();
})().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
});
