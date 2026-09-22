"use strict";

const path = require("node:path");

const debuggerDir = process.env.WMPF_DEBUGGER_DIR;
if (!debuggerDir) throw new Error("WMPF_DEBUGGER_DIR is required");
const frida = require(path.join(debuggerDir, "node_modules", "frida"));

const pid = Number(process.argv[2]);
const threadId = Number(process.argv[3]);
const hwndText = process.argv[4];
const urlText = process.argv[5];
if (!Number.isInteger(pid) || !Number.isInteger(threadId) || !hwndText || !urlText) {
  throw new Error(
    "usage: node tools/open_search_tab.js <weixin-pid> <ui-thread-id> <hwnd> <url>",
  );
}

(async () => {
  const session = await (await frida.getLocalDevice()).attach(pid);
  const script = await session.createScript(`
    "use strict";
    const expectedThreadId = ${threadId};
    const hwnd = ptr(${JSON.stringify(hwndText)});
    const urlText = ${JSON.stringify(urlText)};
    const extraText = "{}";
    const host = Process.getModuleByName("wmpf_host_export_x64.dll");
    const getService = new NativeFunction(
      host.getExportByName("GetBrowsingService"), "pointer", [],
    );
    const service = getService();
    const queryInterface = new NativeFunction(
      service.readPointer().readPointer(),
      "uint64",
      ["pointer", "pointer", "pointer"],
    );
    const output = Memory.alloc(Process.pointerSize);
    output.writePointer(NULL);
    const queryStatus = queryInterface(
      service,
      Memory.allocUtf8String("IWeChatBrowserManager"),
      output,
    );
    const manager = output.readPointer();
    if (manager.isNull()) throw new Error("IWeChatBrowserManager is unavailable");
    const addTab = new NativeFunction(
      manager.readPointer().add(3 * Process.pointerSize).readPointer(),
      "void",
      ["pointer", "int", "pointer", "uint32", "pointer", "uint32"],
    );
    const url = Memory.allocUtf8String(urlText);
    const extra = Memory.allocUtf8String(extraText);
    const dispatch = Module.getGlobalExportByName("DispatchMessageW");
    const postMessage = new NativeFunction(
      Module.getGlobalExportByName("PostMessageW"),
      "bool",
      ["pointer", "uint32", "uint64", "uint64"],
    );
    let pending = true;
    Interceptor.attach(dispatch, {
      onEnter() {
        if (!pending || Process.getCurrentThreadId() !== expectedThreadId) return;
        pending = false;
        try {
          addTab(manager, 2, url, urlText.length, extra, extraText.length);
          send({
            event: "completed",
            pid: Process.id,
            threadId: Process.getCurrentThreadId(),
            queryStatus: String(queryStatus),
          });
        } catch (error) {
          send({event: "error", error: String(error), stack: error.stack || ""});
        }
      },
    });
    send({
      event: "ready",
      pid: Process.id,
      threadId: expectedThreadId,
      posted: postMessage(hwnd, 0, 0, 0),
    });
  `);
  let done = false;
  let failed = false;
  script.message.connect((message) => {
    const payload = message.type === "send" ? message.payload : message;
    process.stdout.write(JSON.stringify(payload) + "\n");
    if (payload.event === "completed") done = true;
    if (payload.event === "error" || message.type === "error") {
      failed = true;
      done = true;
    }
  });
  await script.load();
  for (let index = 0; index < 150 && !done; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await session.detach();
  if (!done) throw new Error("UI-thread AddTab callback did not run");
  if (failed) process.exitCode = 1;
})().catch((error) => {
  process.stderr.write((error.stack || String(error)) + "\n");
  process.exitCode = 1;
});
