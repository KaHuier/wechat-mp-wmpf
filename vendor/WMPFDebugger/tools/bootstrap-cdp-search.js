"use strict";

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const frida = require("frida");

const mainPid = Number(process.argv[2]);
if (!Number.isInteger(mainPid)) {
    throw new Error("usage: node bootstrap-cdp-search.js <weixin-main-pid>");
}

const URI = "weixin://resourceid/Search/app.html?isHomePage=1&lang=zh_CN&scene=243&type=0&query=%E6%B5%8B%E8%AF%95%E8%AE%BA%E9%81%93";
const CONFIG = {
    Version: 25710,
    LoadStartHookOffset: "0x2d45e40",
    CDPFilterHookOffset: "0x39f5aa0",
    SceneOffsets: [64, 1568, 8, 1504, 16, 456],
};

const runPowerShell = (command) => new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-Command", command], (error, stdout, stderr) => {
        if (stdout.trim()) process.stdout.write(stdout);
        if (stderr.trim()) process.stderr.write(stderr);
        error ? reject(error) : resolve();
    });
});

(async () => {
    const device = await frida.getLocalDevice();
    const mainSession = await device.attach(mainPid);
    await mainSession.enableChildGating();
    let rootPid = null;
    let rootSession = null;
    let hookScript = null;
    let resolveRoot;
    const rootReady = new Promise((resolve) => { resolveRoot = resolve; });
    const hookPath = path.join(__dirname, "..", "frida", "hook.js");
    const hookSource = fs.readFileSync(hookPath, "utf8").replace("@@CONFIG@@", JSON.stringify(CONFIG));

    device.childAdded.connect(async (child) => {
        if (child.parentPid !== mainPid || rootPid !== null) {
            await device.resume(child.pid);
            return;
        }
        rootPid = child.pid;
        console.log(JSON.stringify({ event: "wmpf_root_blocked", rootPid, identifier: child.identifier }));
        try {
            rootSession = await device.attach(rootPid);
            hookScript = await rootSession.createScript(hookSource);
            hookScript.message.connect((message) => {
                if (message.type === "send") console.log(JSON.stringify({ event: "hook", payload: message.payload }));
                else console.error(JSON.stringify(message));
            });
            await hookScript.load();
            console.log(JSON.stringify({ event: "hook_loaded", rootPid, config: CONFIG }));
        } finally {
            await device.resume(rootPid);
        }
        resolveRoot(rootPid);
    });

    console.log(JSON.stringify({ event: "main_gating_ready", mainPid }));
    await runPowerShell(`Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'WeChatAppEx.exe' -and $_.ParentProcessId -eq ${mainPid}} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await runPowerShell(`Start-Process '${URI}'`);
    console.log(JSON.stringify({ event: "bootstrap_uri_opened", uri: URI }));
    await Promise.race([
        rootReady,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for WMPF root")), 300000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await runPowerShell(`Start-Process '${URI}'`);
    console.log(JSON.stringify({ event: "search_uri_opened", uri: URI }));
    await new Promise((resolve) => setTimeout(resolve, 45000));
    console.log(JSON.stringify({ event: "complete", rootPid }));
    if (hookScript) await hookScript.unload();
    if (rootSession) await rootSession.detach();
    await mainSession.disableChildGating();
    await mainSession.detach();
})().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
});
