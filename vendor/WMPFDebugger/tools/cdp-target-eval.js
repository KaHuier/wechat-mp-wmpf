"use strict";

const WebSocket = require("ws");

const targetId = process.argv[2];
const expression =
    process.env.CDP_EXPRESSION ||
    `({url: location.href, title: document.title, text: document.body.innerText.slice(0, 20000)})`;
const timeoutMs = Number(process.argv[3] || 20000);

if (!targetId) {
    throw new Error("usage: node tools/cdp-target-eval.js <targetId> [timeoutMs]");
}

const socket = new WebSocket("ws://127.0.0.1:62000");
let sessionId = null;
const timer = setTimeout(() => {
    console.error("Timed out waiting for target evaluation");
    socket.close();
    process.exitCode = 1;
}, timeoutMs);

socket.on("open", () => {
    socket.send(
        JSON.stringify({
            id: 1,
            method: "Target.attachToTarget",
            params: { targetId, flatten: true },
        }),
    );
});

socket.on("message", (data) => {
    const text = data.toString();
    let message;
    try {
        message = JSON.parse(text);
    } catch (_) {
        console.log(text);
        return;
    }

    if (message.id === 1) {
        sessionId = message.result && message.result.sessionId;
        if (!sessionId) {
            console.error(text);
            clearTimeout(timer);
            socket.close();
            process.exitCode = 1;
            return;
        }
        socket.send(
            JSON.stringify({
                id: 2,
                sessionId,
                method: "Runtime.evaluate",
                params: {
                    expression,
                    awaitPromise: true,
                    returnByValue: true,
                },
            }),
        );
        return;
    }

    if (message.id === 2) {
        console.log(JSON.stringify(message, null, 2));
        clearTimeout(timer);
        socket.close();
    }
});

socket.on("error", (error) => {
    clearTimeout(timer);
    console.error(error.message);
    process.exitCode = 1;
});
