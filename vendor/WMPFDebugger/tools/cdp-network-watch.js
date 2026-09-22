"use strict";

const WebSocket = require("ws");

const socket = new WebSocket("ws://127.0.0.1:62000");
let nextId = 1;
const sessions = new Map();
const attachedTargets = new Set();

function send(method, params = {}, sessionId) {
    const message = { id: nextId++, method, params };
    if (sessionId) message.sessionId = sessionId;
    socket.send(JSON.stringify(message));
    return message.id;
}

function safeUrl(raw) {
    try {
        const url = new URL(raw);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        return url.toString();
    } catch (_) {
        return null;
    }
}

function attach(targetInfo) {
    if (!targetInfo || targetInfo.type !== "page" || attachedTargets.has(targetInfo.targetId)) return;
    attachedTargets.add(targetInfo.targetId);
    console.log(`[target] ${targetInfo.targetId} ${targetInfo.title || "(untitled)"} ${targetInfo.url || ""}`);
    send("Target.attachToTarget", { targetId: targetInfo.targetId, flatten: true });
}

socket.on("open", () => {
    send("Target.setDiscoverTargets", { discover: true });
    send("Target.getTargets");
});

socket.on("message", (raw) => {
    let message;
    try {
        message = JSON.parse(raw.toString());
    } catch (_) {
        return;
    }

    if (message.method === "Target.targetCreated" || message.method === "Target.targetInfoChanged") {
        attach(message.params && message.params.targetInfo);
        return;
    }

    if (message.result && Array.isArray(message.result.targetInfos)) {
        for (const targetInfo of message.result.targetInfos) attach(targetInfo);
        return;
    }

    if (message.result && message.result.sessionId) {
        const sessionId = message.result.sessionId;
        sessions.set(sessionId, true);
        send("Network.enable", {}, sessionId);
        send("Page.enable", {}, sessionId);
        return;
    }

    if (message.method === "Network.requestWillBeSent") {
        const request = message.params && message.params.request;
        const url = request && safeUrl(request.url);
        if (url) console.log(`[request] ${request.method} ${url}`);
        return;
    }

    if (message.method === "Page.frameNavigated") {
        const frame = message.params && message.params.frame;
        const url = frame && safeUrl(frame.url);
        if (url) console.log(`[navigate] ${frame.name || "main"} ${url}`);
    }
});

socket.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
});

process.on("SIGINT", () => socket.close());
