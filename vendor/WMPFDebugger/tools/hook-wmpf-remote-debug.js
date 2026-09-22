"use strict";

const frida = require("frida");

const pid = Number(process.argv[2]);
const port = Number(process.argv[3] || 9222);

if (!Number.isInteger(pid) || !Number.isInteger(port)) {
    throw new Error(
        "usage: node tools/hook-wmpf-remote-debug.js <weixin-pid> [port]",
    );
}

(async () => {
    const device = await frida.getLocalDevice();
    const session = await device.attach(pid);
    const source = `
        "use strict";

        const port = ${port};
        const suffix =
            " --remote-debugging-port=" + port +
            " --remote-debugging-address=127.0.0.1" +
            " --remote-allow-origins=http://127.0.0.1:" + port;
        const hooked = new Set();

        const patchCommandLine = (context, args, index, api) => {
            const pointer = args[index];
            if (pointer.isNull()) return;
            let commandLine;
            try {
                commandLine = pointer.readUtf16String();
            } catch (_) {
                return;
            }
            if (
                !commandLine ||
                !/WeChatAppEx\\.exe/i.test(commandLine) ||
                /(?:^|\\s)--type=/.test(commandLine) ||
                /--remote-debugging-(?:port|pipe)/.test(commandLine)
            ) return;

            const replacement = Memory.allocUtf16String(commandLine + suffix);
            context._wmpfCommandLine = replacement;
            if (Process.arch === "x64") {
                const registers = ["rcx", "rdx", "r8", "r9"];
                if (index < registers.length) {
                    context.context[registers[index]] = replacement;
                } else {
                    args[index] = replacement;
                }
            } else {
                args[index] = replacement;
            }
            send({
                type: "patched-command-line",
                api,
                commandLine: commandLine + suffix,
            });
        };

        const attach = (moduleName, exportName, commandLineIndex) => {
            let address;
            try {
                address = Process.getModuleByName(moduleName)
                    .getExportByName(exportName);
            } catch (_) {
                return;
            }
            const key = address.toString();
            if (hooked.has(key)) return;
            hooked.add(key);
            Interceptor.attach(address, {
                onEnter(args) {
                    patchCommandLine(this, args, commandLineIndex, exportName);
                },
            });
            send({ type: "hook-installed", moduleName, exportName, address: key });
        };

        attach("KernelBase.dll", "CreateProcessW", 1);
        attach("KernelBase.dll", "CreateProcessAsUserW", 2);
        attach("KernelBase.dll", "CreateProcessWithTokenW", 2);
        attach("KernelBase.dll", "CreateProcessWithLogonW", 3);
        attach("KernelBase.dll", "CreateProcessInternalW", 2);
        attach("kernel32.dll", "CreateProcessW", 1);
        attach("advapi32.dll", "CreateProcessAsUserW", 2);
        send({ type: "ready", port, hooks: hooked.size });
    `;

    const script = await session.createScript(source);
    script.message.connect((message) => {
        if (message.type === "error") {
            console.error(message.stack || message.description);
        } else {
            console.log(JSON.stringify(message.payload));
        }
    });
    session.detached.connect((reason) => {
        console.error(`target detached: ${reason}`);
        process.exit(0);
    });
    await script.load();

    const stop = async () => {
        try {
            await script.unload();
            await session.detach();
        } finally {
            process.exit(0);
        }
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await new Promise(() => {});
})().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
