import { IPlatform, WmpfProcessInfo } from "./types";
import * as frida from "frida"

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
            p.parameters.ppid !== undefined
                ? Number(p.parameters.ppid)
                : 0,
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
        const wmpfProcess = processes.find(
            (process) => process.pid === wmpfPid,
        );
        if (wmpfProcess === undefined) {
            throw new Error("[frida] wmpf browser process not found");
        }
        const argv = (wmpfProcess.parameters.argv || []) as string[];
        const runtimeArg = argv.find((value) =>
            value.startsWith("--flue-runtime-dir"),
        );
        const versionSource = runtimeArg
            ? runtimeArg
            : wmpfProcess.parameters.path as string | undefined;
        const versionInPath = versionSource?.match(
            /RadiumWMPF[\\/](\d+)[\\/]/i,
        );
        const wmpfVersion = versionInPath ? Number(versionInPath[1]) : 0;
        if (wmpfVersion === 0) {
            throw new Error("[frida] error in find wmpf version");
        }
        return { pid: Number(wmpfPid), version: wmpfVersion }
    }
}
