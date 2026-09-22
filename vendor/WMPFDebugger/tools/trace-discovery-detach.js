"use strict";

// Dynamic tracer for the Search/Discover detach JSAPI in flue.dll 25710.
// It is intentionally read-only: every hook records arguments and stacks,
// while the target process continues with its original implementation.

const fs = require("fs");
const frida = require("frida");

const pid = Number(process.argv[2]);
const outputPath = process.argv[3];

if (!Number.isInteger(pid) || !outputPath) {
    throw new Error(
        "usage: node tools/trace-discovery-detach.js <wmpf-root-pid> <output.jsonl>",
    );
}

const offsets = {
    jsapiName: 0x2778230,
    jsapiInvoke: 0x5a2c5a0,
    jsapiDestroy: 0x2780620,
    jsapiResult: 0x59fc380,
    discoverDetachA: 0x2aeecf0,
    discoverDetachB: 0x2af2e50,
    nativeDetach: 0x2af34c0,
};

function append(value) {
    const line = JSON.stringify(value);
    fs.appendFileSync(outputPath, line + "\n", "utf8");
    process.stdout.write(line + "\n");
}

(async () => {
    fs.writeFileSync(outputPath, "", "utf8");
    const device = await frida.getLocalDevice();
    const session = await device.attach(pid);
    const source = `
        "use strict";
        const offsets = ${JSON.stringify(offsets)};
        const module = Process.getModuleByName("flue.dll");
        const activeThreads = new Map();

        function stack(context) {
            try {
                return Thread.backtrace(context, Backtracer.ACCURATE)
                    .map(DebugSymbol.fromAddress)
                    .map((item) => item.toString());
            } catch (error) {
                return ["<backtrace failed: " + error + ">"];
            }
        }

        function emit(event, fields) {
            send(Object.assign({
                event,
                timestamp: new Date().toISOString(),
                threadId: Process.getCurrentThreadId(),
            }, fields || {}));
        }

        function ptrText(value) {
            try { return value.toString(); } catch (_) { return null; }
        }

        function hookFlue(name, offset, trackScope) {
            const address = module.base.add(offset);
            Interceptor.attach(address, {
                onEnter(args) {
                    const tid = Process.getCurrentThreadId();
                    this.tid = tid;
                    if (trackScope) activeThreads.set(tid, (activeThreads.get(tid) || 0) + 1);
                    emit(name + ":enter", {
                        moduleOffset: "0x" + offset.toString(16),
                        args: [0, 1, 2, 3].map((index) => ptrText(args[index])),
                        backtrace: stack(this.context),
                    });
                },
                onLeave(retval) {
                    emit(name + ":leave", { retval: ptrText(retval) });
                    if (trackScope) {
                        const depth = (activeThreads.get(this.tid) || 1) - 1;
                        if (depth > 0) activeThreads.set(this.tid, depth);
                        else activeThreads.delete(this.tid);
                    }
                },
            });
        }

        hookFlue("jsapi_name", offsets.jsapiName, false);
        hookFlue("jsapi_invoke", offsets.jsapiInvoke, true);
        hookFlue("jsapi_destroy", offsets.jsapiDestroy, false);
        hookFlue("jsapi_result", offsets.jsapiResult, false);
        hookFlue("discover_detach_a", offsets.discoverDetachA, true);
        hookFlue("discover_detach_b", offsets.discoverDetachB, true);
        hookFlue("native_detach", offsets.nativeDetach, true);

        const user32 = Process.getModuleByName("user32.dll");
        for (const exportName of [
            "CreateWindowExW",
            "ShowWindow",
            "SetParent",
            "SetWindowLongPtrW",
            "SetWindowPos",
            "MoveWindow",
        ]) {
            const address = user32.findExportByName(exportName);
            if (address === null) continue;
            Interceptor.attach(address, {
                onEnter(args) {
                    const tid = Process.getCurrentThreadId();
                    if (!activeThreads.has(tid)) return;
                    this.traced = true;
                    emit("user32:" + exportName, {
                        args: [0, 1, 2, 3, 4, 5].map((index) => ptrText(args[index])),
                        backtrace: stack(this.context),
                    });
                },
                onLeave(retval) {
                    if (this.traced) emit("user32:" + exportName + ":return", { retval: ptrText(retval) });
                },
            });
        }

        emit("ready", {
            pid: Process.id,
            moduleBase: module.base.toString(),
            moduleSize: module.size,
            offsets,
        });
    `;
    const script = await session.createScript(source);
    script.message.connect((message) => {
        if (message.type === "send") append(message.payload);
        else append({ event: "frida_error", message });
    });
    await script.load();

    const stop = async () => {
        try { await session.detach(); } catch (_) {}
        process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await new Promise(() => {});
})().catch((error) => {
    append({ event: "controller_error", error: error.stack || String(error) });
    process.exitCode = 1;
});
