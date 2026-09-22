"use strict";

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const frida = require("frida");

const rootPid = Number(process.argv[2]);
if (!Number.isInteger(rootPid)) throw new Error("usage: node patch-search-live.js <wmpf-root-pid>");

const URI = "weixin://resourceid/Search/app.html?isHomePage=1&lang=zh_CN&scene=243&type=0&query=%E6%B5%8B%E8%AF%95%E8%AE%BA%E9%81%93";
const USERS = path.join(process.env.APPDATA, "Tencent", "xwechat", "radium", "users");
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
    for (const file of findFiles(USERS)) {
        let text = fs.readFileSync(file, "utf8");
        if (!text.includes("__wechatMpAutoDetached")) {
            const count = text.split(NEEDLE).length - 1;
            if (count !== 1) { rows.push({ file, result: "patch_point_count", count }); continue; }
            text = text.replace(NEEDLE, INJECTION);
            fs.writeFileSync(file, text, "utf8");
            rows.push({ file, result: "patched" });
        } else rows.push({ file, result: "already_patched" });
    }
    console.log(JSON.stringify({ event: "resources_patched", rows }));
}

(async () => {
    const session = await (await frida.getLocalDevice()).attach(rootPid);
    const source = `
        "use strict";
        let sequence = 0;
        const hooked = new Set();
        function attach(moduleName, exportName, index) {
            let address; try { address = Process.getModuleByName(moduleName).getExportByName(exportName); } catch (_) { return; }
            if (hooked.has(address.toString())) return; hooked.add(address.toString());
            Interceptor.attach(address, { onEnter(args) {
                let commandLine; try { commandLine = args[index].readUtf16String(); } catch (_) { return; }
                if (!commandLine || !commandLine.includes("--type=renderer") || !/--wmpf-render-type=(?:0|7)(?:\\s|$)/.test(commandLine)) return;
                const id = ++sequence;
                send({ event: "search_spawn_blocked", id, api: exportName });
                recv("release-search-" + id, () => {}).wait();
                send({ event: "search_spawn_released", id, api: exportName });
            }});
        }
        attach("KernelBase.dll", "CreateProcessW", 1);
        attach("KernelBase.dll", "CreateProcessInternalW", 2);
        attach("kernel32.dll", "CreateProcessW", 1);
        send({ event: "ready", pid: Process.id, hooks: hooked.size });
    `;
    const script = await session.createScript(source);
    script.message.connect((message) => {
        if (message.type !== "send") { console.error(JSON.stringify(message)); return; }
        const payload = message.payload;
        console.log(JSON.stringify(payload));
        if (payload.event === "search_spawn_blocked") {
            try { patchResources(); }
            finally { script.post({ type: "release-search-" + payload.id }); }
        }
    });
    await script.load();
    await runPowerShell(`Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'WeChatAppEx.exe' -and $_.ParentProcessId -eq ${rootPid} -and $_.CommandLine -match 'wmpf-render-type=(0|7)'} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force}`);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await runPowerShell(`Start-Process '${URI}'`);
    await new Promise((resolve) => setTimeout(resolve, 15000));
    await script.unload();
    await session.detach();
})().catch((error) => { console.error(error.stack || String(error)); process.exitCode = 1; });
