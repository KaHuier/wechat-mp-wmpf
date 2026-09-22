"use strict";

// Invoke Search's native "show as independent window" action on the WMPF UI
// thread. Offsets below are valid only for WMPF runtime 25710.
const path = require("node:path");
const debuggerDir = process.env.WMPF_DEBUGGER_DIR;
if (!debuggerDir) throw new Error("WMPF_DEBUGGER_DIR is required");
const frida = require(path.join(debuggerDir, "node_modules", "frida"));
const pid = Number(process.argv[2]);
const threadId = Number(process.argv[3]);
const timeoutMs = 15000;
if (!Number.isInteger(pid) || !Number.isInteger(threadId)) {
  throw new Error("usage: node invoke_search_detach.js <wmpf-root-pid> <ui-thread-id>");
}

(async () => {
  const session = await (await frida.getLocalDevice()).attach(pid);
  let finished = false;
  let timer;
  const source = `
    "use strict";
    const expectedThreadId = ${threadId};
    const flue = Process.getModuleByName("flue.dll");
    if (!/[\\\\/]25710[\\\\/]/.test(flue.path)) {
      throw new Error("unsupported WMPF runtime: " + flue.path);
    }
    const valueInit = new NativeFunction(flue.base.add(0x3a0860), "pointer", ["pointer", "uchar"]);
    const dictSet = new NativeFunction(flue.base.add(0x40813a0), "pointer", ["pointer", "pointer", "pointer"]);
    const invokeNative = new NativeFunction(flue.base.add(0x280f190), "void", ["pointer", "pointer", "pointer"]);
    const valueDestroy = new NativeFunction(flue.base.add(0x50e4530), "void", ["pointer"]);
    const manager = flue.base.add(0xdc1cca0);
    const dispatchPoint = flue.base.add(0x3e679e0);
    const methodText = "xweb_call_discovery_detach_button_clicked";
    let pending = true;

    Interceptor.attach(dispatchPoint, {
      onEnter() {
        if (!pending || Process.getCurrentThreadId() !== expectedThreadId) return;
        pending = false;
        let dict = NULL;
        try {
          dict = Memory.alloc(0x20);
          dict.writeByteArray(new Uint8Array(0x20));
          valueInit(dict, 6);
          const intValue = Memory.alloc(0x20);
          intValue.writeByteArray(new Uint8Array(0x20));
          intValue.writeS32(2);
          intValue.add(0x18).writeU8(2);
          const key = Memory.alloc(0x10);
          key.writePointer(flue.base.add(0xbfb052f));
          key.add(8).writeU64(3);
          dictSet(dict, key, intValue);
          const methodBuffer = Memory.allocUtf8String(methodText);
          const method = Memory.alloc(0x18);
          method.writeByteArray(new Uint8Array(0x18));
          method.writePointer(methodBuffer);
          method.add(8).writeU64(methodText.length);
          method.add(16).writeU64(uint64("0x8000000000000030"));
          invokeNative(manager, method, dict);
          valueDestroy(dict);
          send({event:"completed", status:"ok", pid:Process.id,
            threadId:Process.getCurrentThreadId(), biz:2});
        } catch (error) {
          send({event:"error", error:String(error), stack:error.stack || ""});
        }
      }
    });
    send({event:"ready", pid:Process.id, expectedThreadId,
      dispatchPoint:dispatchPoint.toString()});
  `;

  const script = await session.createScript(source);
  const finish = async code => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { await session.detach(); } catch (_) {}
    process.exitCode = code;
  };
  script.message.connect(message => {
    const payload = message.type === "send" ? message.payload : {event:"frida_error", message};
    process.stdout.write(JSON.stringify(payload) + "\n");
    if (payload.event === "completed") finish(0).catch(console.error);
    if (payload.event === "error" || payload.event === "frida_error") finish(1).catch(console.error);
  });
  timer = setTimeout(() => {
    process.stdout.write(JSON.stringify({event:"timeout", timeoutMs, threadId}) + "\n");
    finish(2).catch(console.error);
  }, timeoutMs);
  await script.load();
  while (!finished) await new Promise(resolve => setTimeout(resolve, 50));
})().catch(error => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
