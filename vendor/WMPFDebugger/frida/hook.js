const getPlatform = () => {
    // retval: "windows" | "linux" | "darwin"
    return Process.platform;
}

const getMainModule = (version) => {
    const osPlatform = getPlatform();
    if (osPlatform === 'windows') {
        if (version >= 13331) {
            return Process.findModuleByName("flue.dll");
        }
        return Process.findModuleByName("WeChatAppEx.exe");
    } else if (osPlatform === 'linux') {
        return Process.findModuleByName("WeChatAppEx");
    } else if (osPlatform === 'darwin') {
        return Process.findModuleByName("WeChatAppEx Framework");
    }
};

const patchCDPFilter = (base, config) => {
    if (config.Version >= 25710) {
        send("[patch] legacy CDP filter patch skipped for WMPF >= 25710");
        return;
    }
    // xref: SendToClientFilter OR devtools_message_filter_applet_webview.cc
    const offset = config.CDPFilterHookOffset;
    Interceptor.attach(base.add(offset), {
        onLeave(retval_) {
            // see https://github.com/evi0s/WMPFDebugger/pull/262
            const retval = getPlatform() == 'windows'
                ? retval_.readPointer()
                : retval_;
            if (retval.isNull()) return;
            try {
                const val = retval.add(8).readU32();
                send(`[patch] CDP filter on leave, retval+8 = ${val}`);
                if (val === 6) {
                    retval.add(8).writeU32(0x0);
                    send("[patch] CDP filter patched");
                }
            } catch (e) {
                send(`[patch] CDP filter error: ${e}`);
            }
        }
    });
};

const hookOnLoadScene = (a1, sceneOffsets, version) => {
    let miniappScenePtr;
    let fifth;
    try {
        const first = a1.add(sceneOffsets[0]).readPointer();
        const miniappConfigPtr = first
            .add(sceneOffsets[1])
            .readPointer();
        const third = miniappConfigPtr
            .add(sceneOffsets[2])
            .readPointer();
        const fourth = third
            .add(sceneOffsets[3])
            .readPointer();
        fifth = fourth
            .add(sceneOffsets[4])
            .readPointer();
        miniappScenePtr = fifth.add(sceneOffsets[5]);
        send(
            `[hook] scene chain: first=${first}, config=${miniappConfigPtr}, ` +
                `third=${third}, fourth=${fourth}, fifth=${fifth}`,
        );
        send(`[hook] scene: ${miniappScenePtr.readInt()}`);
    } catch (error) {
        send(`[hook] scene chain error: ${error}`);
        return;
    }

    // 1000: Search runtime, not a miniapp debug session (upstream excludes it)
    // 1007: from issue #80
    // 1008: from issue #53
    // 1011: scan QR code
    // 1012: recognize QR code from long-pressed image (issue #128)
    // 1027: from issue #78
    // 1035: from issue #78
    // 1037: opened from another mini program
    // 1053: from issue #25
    // 1074: from issue #32
    // 1145: from search
    // 1178: from phone (issue #117)
    // 1256: from recent
    // 1260: from frequently used
    // 1302: from services
    // 1308: minigame?
    const sceneNumberArray = [
        1005, 1007, 1008, 1011, 1012, 1027, 1035, 1037, 1053, 1074, 1145, 1178,
        1256, 1260, 1302, 1308,
    ];
    if (!sceneNumberArray.includes(miniappScenePtr.readInt())) {
        return;
    }
    send("[hook] hook scene condition -> 1101");
    miniappScenePtr.writeInt(1101);
    try {
        const mode = fifth.add(0x2d4).readS32();
        const inlineLength = fifth.add(0x1b7).readS8();
        const appIdLength = inlineLength < 0
            ? fifth.add(0x1a8).readU64().toString()
            : String(inlineLength);
        send(
            `[diagnostic] remote debug condition: mode=${mode}, ` +
                `scene=${miniappScenePtr.readS32()}, app_id_length=${appIdLength}`,
        );
    } catch (error) {
        send(`[diagnostic] remote debug condition read failed: ${error}`);
    }

    // TODO: customize debugging endpoint
    // const websocketServerStringPtr = passArgs.add(8).readPointer().add(520);
    // VERBOSE && console.log("[hook] hook websocket server, original: ", websocketServerStringPtr.readUtf8String());
    // websocketServerStringPtr.writeUtf8String("ws://127.0.0.1:8189/");
};

const patchOnLoadStart = (base, config) => {
    // xref: AppletIndexContainer::OnLoadStart
    Interceptor.attach(base.add(config.LoadStartHookOffset), {
        onEnter(args) {
            const originalDebugFlag = args[1].and(0xff).toInt32();
            send(
                `[inteceptor] AppletIndexContainer::OnLoadStart onEnter, ` +
                    `indexContainer.this: ${args[0]}, debug_flag: ${originalDebugFlag}`,
            );
            // write debug_flag to 0x1
            if (args[1].and(0xff).toInt32() !== 1) {
                const patchedFlag = args[1]
                    .and(ptr("0xffffffffffffff00"))
                    .or(1);
                if (getPlatform() === "windows" && Process.arch === "x64") {
                    // Frida 17 no longer reliably writes the Windows x64 RDX
                    // argument register through assignment to args[1]. Update
                    // the CPU context explicitly so the following
                    // `mov ebx, edx` observes the patched value.
                    this.context.rdx = patchedFlag;
                } else {
                    args[1] = patchedFlag;
                }
            }
            const effectiveFlag =
                getPlatform() === "windows" && Process.arch === "x64"
                    ? this.context.rdx.and(0xff).toInt32()
                    : args[1].and(0xff).toInt32();
            send(`[hook] debug_flag patched: ${effectiveFlag}`);
            // handle onLoad scene
            hookOnLoadScene(args[0], config.SceneOffsets, config.Version);
        },
        onLeave(retval) {
            // do nothing
        },
    });
};

const patchDebugInitDiagnostic = (base, config) => {
    if (config.Version !== 25710) return;
    Interceptor.attach(base.add(0x369d300), {
        onEnter(args) {
            send(
                `[diagnostic] remote debug initializer entered, ` +
                    `arg0=${args[0]}, arg1=${args[1]}`,
            );
        },
    });
};

const parseConfig = () => {
    const rawConfig = `@@CONFIG@@`;
    if (rawConfig.includes("@@")) {
        // test addresses
        return {
            Version: 18955,
            LoadStartHookOffset: "0x25B52C0",
            CDPFilterHookOffset: "0x30248B0",
            SceneOffsets: [1408, 1344, 488],
        };
    }
    return JSON.parse(rawConfig);
};

const main = () => {
    const config = parseConfig();
    const mainModule = getMainModule(config.Version);
    if (mainModule === null) {
        setTimeout(main, 10);
        return;
    }
    patchOnLoadStart(mainModule.base, config);
    patchCDPFilter(mainModule.base, config);
    patchDebugInitDiagnostic(mainModule.base, config);
};

main();
