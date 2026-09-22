"use strict";

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const frida = require("frida");

const mainPid = Number(process.argv[2]);
if (!Number.isInteger(mainPid)) throw new Error("usage: node bootstrap-search-autodetach.js <weixin-main-pid>");

const URI = "weixin://resourceid/Search/app.html?isHomePage=1&lang=zh_CN&scene=243&type=0&query=%E6%B5%8B%E8%AF%95%E8%AE%BA%E9%81%93";
const RADium = path.join(process.env.APPDATA, "Tencent", "xwechat", "radium", "users");
const FILE_NAME = "build.ab01b451c09dbf83f9e7c1f321eaca27.js";
const NEEDLE = "mounted:function(){var t=this;262208===o.mL.type&&setTimeout(function(){t.getData({},o.mL.type,!1)});";
const INJECTION = NEEDLE + "window.__wechatMpAutoDetachTries=0;window.__wechatMpAutoDetachTimer=setInterval(function(){if(++window.__wechatMpAutoDetachTries>40){clearInterval(window.__wechatMpAutoDetachTimer);return}if(!window.__wechatMpAutoDetached&&\"DiscoverPage\"===t.$store.state.pcWindowViewScene&&o.FH.onDiscoveryDetachButtonClicked.canIUse()){window.__wechatMpAutoDetached=!0;clearInterval(window.__wechatMpAutoDetachTimer);o.FH.onDiscoveryDetachButtonClicked()}},250);";

const runPowerShell = (command) => new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-Command", command], (error) => error ? reject(error) : resolve());
});

function findFiles(directory, output = []) {
    if (!fs.existsSync(directory)) return output;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) findFiles(full, output);
        else if (entry.name === FILE_NAME) output.push(full);
    }
    return output;
}

function patchResources() {
    const rows = [];
    for (const file of findFiles(RADium)) {
        let text = fs.readFileSync(file, "utf8");
        if (text.includes("__wechatMpAutoDetached")) {
            rows.push({ file, result: "already_patched" });
            continue;
        }
        const count = text.split(NEEDLE).length - 1;
        if (count !== 1) {
            rows.push({ file, result: "patch_point_count", count });
            continue;
        }
        text = text.replace(NEEDLE, INJECTION);
        fs.writeFileSync(file, text, "utf8");
        rows.push({ file, result: "patched" });
    }
    console.log(JSON.stringify({ event: "resources_patched", rows }));
    if (!rows.some((row) => row.result === "patched" || row.result === "already_patched")) {
        throw new Error("no Search resource was patched");
    }
}

const rootSource = `
    "use strict";
    let sequence = 0;
    const hooked = new Set();
    function attach(moduleName, exportName, index) {
        let address;
        try { address = Process.getModuleByName(moduleName).getExportByName(exportName); } catch (_) { return; }
        if (hooked.has(address.toString())) return;
        hooked.add(address.toString());
        Interceptor.attach(address, { onEnter(args) {
            let commandLine;
            try { commandLine = args[index].readUtf16String(); } catch (_) { return; }
            if (!commandLine || !commandLine.includes("--type=renderer") || !commandLine.includes("--wmpf-render-type=7")) return;
            const id = ++sequence;
            send({ event: "search_spawn_blocked", id, api: exportName, commandLine });
            recv("release-search-" + id, () => {}).wait();
            send({ event: "search_spawn_released", id, api: exportName });
        }});
    }
    attach("KernelBase.dll", "CreateProcessW", 1);
    attach("KernelBase.dll", "CreateProcessInternalW", 2);
    attach("kernel32.dll", "CreateProcessW", 1);
    send({ event: "root_hook_ready", pid: Process.id });
`;

(async () => {
    const device = await frida.getLocalDevice();
    const mainSession = await device.attach(mainPid);
    await mainSession.enableChildGating();
    let rootSession = null;
    let rootScript = null;
    let rootPid = null;
    let uriOpened = false;

    device.childAdded.connect(async (child) => {
        if (child.parentPid !== mainPid || rootPid !== null) {
            await device.resume(child.pid);
            return;
        }
        rootPid = child.pid;
        try {
            rootSession = await device.attach(child.pid);
            rootScript = await rootSession.createScript(rootSource);
            rootScript.message.connect((message) => {
                if (message.type !== "send") {
                    console.error(JSON.stringify(message));
                    return;
                }
                const payload = message.payload;
                console.log(JSON.stringify(payload));
                if (payload.event === "search_spawn_blocked") {
                    try { patchResources(); }
                    finally { rootScript.post({ type: "release-search-" + payload.id }); }
                }
            });
            await rootScript.load();
            console.log(JSON.stringify({ event: "root_ready", rootPid }));
        } finally {
            await device.resume(child.pid);
        }
        uriOpened = true;
        setTimeout(() => runPowerShell(`Start-Process '${URI}'`).catch(console.error), 3000);
    });

    console.log(JSON.stringify({ event: "main_gating_ready", mainPid }));
    await runPowerShell(`Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'WeChatAppEx.exe' -and $_.ParentProcessId -eq ${mainPid}} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (!uriOpened) {
        uriOpened = true;
        await runPowerShell(`Start-Process '${URI}'`);
    }
    await new Promise((resolve) => setTimeout(resolve, 18000));
    console.log(JSON.stringify({ event: "complete", rootPid }));
    if (rootScript) await rootScript.unload();
    if (rootSession) await rootSession.detach();
    await mainSession.disableChildGating();
    await mainSession.detach();
})().catch((error) => { console.error(error.stack || String(error)); process.exitCode = 1; });
