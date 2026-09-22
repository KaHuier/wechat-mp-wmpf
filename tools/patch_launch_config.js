"use strict";

// Version-locked WMPF 25710 hook. It changes one ordinary applet launch into
// the remote-debug launch mode expected by WMPFDebugger before OnLoadStart.
const path = require("node:path");
const debuggerDir = process.env.WMPF_DEBUGGER_DIR;
if (!debuggerDir) throw new Error("WMPF_DEBUGGER_DIR is required");
const frida = require(path.join(debuggerDir, "node_modules", "frida"));
const pid = Number(process.argv[2]);
const targetAppId = process.argv[3];
if (!Number.isInteger(pid) || !/^wx[a-zA-Z0-9]{16}$/.test(targetAppId || "")) {
  throw new Error("usage: node patch_launch_config.js <wmpf-root-pid> <app-id>");
}

const source = `
  "use strict";
  const flue = Process.getModuleByName("flue.dll");
  if (!/[\\\\/]25710[\\\\/]/.test(flue.path)) {
    throw new Error("unsupported WMPF runtime: " + flue.path);
  }
  const targetAppId = ${JSON.stringify(targetAppId)};
  const endpoint = "ws://127.0.0.1:9421";
  function readString(value) {
    const marker = value.add(0x17).readS8();
    const length = marker < 0 ? value.add(8).readU64().toNumber() : marker;
    if (length < 0 || length > 256) return "<invalid>";
    return (marker < 0 ? value.readPointer() : value).readUtf8String(length);
  }
  Interceptor.attach(flue.base.add(0x2e3b6c0), {
    onEnter(args) { this.config = args[1]; },
    onLeave() {
      try {
        const state = this.config;
        if (readString(state) !== targetAppId) return;
        const mode = state.add(0x2d4).readS32();
        const scene = state.add(0x1c8).readS32();
        const remote = state.add(0x1a0);
        if (mode !== 0 || ![1000, 1023].includes(scene) || readString(remote) !== "" ||
            remote.add(0x17).readS8() !== 0 || endpoint.length > 22) {
          send({event:"unexpected_config", mode, scene, endpoint:readString(remote)});
          return;
        }
        remote.writeUtf8String(endpoint);
        remote.add(0x17).writeS8(endpoint.length);
        state.add(0x1c8).writeS32(1101);
        state.add(0x2d4).writeS32(1);
        send({event:"patched", appId:targetAppId, versionType:1,
          launchScene:1101, remoteDebugEndpoint:endpoint});
      } catch (error) {
        send({event:"error", error:String(error), stack:error.stack || ""});
      }
    }
  });
  send({event:"ready", pid:Process.id, runtime:flue.path});
`;

(async () => {
  const session = await (await frida.getLocalDevice()).attach(pid);
  const script = await session.createScript(source);
  script.message.connect(message => {
    const payload = message.type === "send" ? message.payload : message;
    process.stdout.write(JSON.stringify(payload) + "\n");
  });
  await script.load();
  process.on("SIGINT", async () => { await session.detach(); process.exit(0); });
  await new Promise(() => {});
})().catch(error => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
