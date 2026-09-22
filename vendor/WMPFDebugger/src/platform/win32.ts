import { IPlatform, WmpfProcessInfo } from "./types";
import * as frida from "frida"
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export class WindowsPlatform implements IPlatform {
    async findWmpfProcess(): Promise<WmpfProcessInfo> {
        const localDevice = await frida.getLocalDevice();
        const processes = await localDevice.enumerateProcesses({
            scope: frida.Scope.Metadata,
        });
        const wmpfProcesses = processes.filter(
            (process) => process.name === "WeChatAppEx.exe",
        );
        const wmpfPids = wmpfProcesses.map((p) =>
            p.parameters.ppid ? p.parameters.ppid : 0,
        );

        // find the parent process
        const wmpfPid = wmpfPids
            .sort(
                (a, b) =>
                    wmpfPids.filter((v) => v === a).length -
                    wmpfPids.filter((v) => v === b).length,
            )
            .pop();
        if (wmpfPid === undefined) {
            throw new Error("[frida] WeChatAppEx.exe process not found");
        }
        const wmpfProcess = processes.filter(
            (process) => process.pid === wmpfPid,
        )[0];
        const wmpfProcessPath = wmpfProcess.parameters.path as string | undefined;
        let wmpfVersion = 0;
        const versionInPath = wmpfProcessPath?.match(
            /RadiumWMPF[\\/](\d+)[\\/]/i,
        );
        if (versionInPath) {
            wmpfVersion = Number(versionInPath[1]);
        } else if (wmpfProcessPath) {
            // Unified WeChat starts the executable from the RadiumWMPF root,
            // while flue.dll lives under <version>/extracted/runtime. Do not
            // use arbitrary digits from the full path (for example a Windows
            // username ending in digits) as the WMPF version.
            const pluginRoot = path.dirname(wmpfProcessPath);
            const installedVersions = readdirSync(pluginRoot, {
                withFileTypes: true,
            })
                .filter(
                    (entry) =>
                        entry.isDirectory() &&
                        /^\d+$/.test(entry.name) &&
                        existsSync(
                            path.join(
                                pluginRoot,
                                entry.name,
                                "extracted",
                                "runtime",
                                "flue.dll",
                            ),
                        ),
                )
                .map((entry) => Number(entry.name));
            if (installedVersions.length > 0) {
                wmpfVersion = Math.max(...installedVersions);
            }
        }
        if (wmpfVersion === 0) {
            throw new Error("[frida] error in find wmpf version");
        }
        return { pid: Number(wmpfPid), version: wmpfVersion }
    }
}
