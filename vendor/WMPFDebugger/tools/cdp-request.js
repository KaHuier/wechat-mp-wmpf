"use strict";

const WebSocket = require("ws");

const method = process.argv[2] || "Target.getTargets";
const rawParams = process.env.CDP_PARAMS || process.argv[3];
const params = rawParams ? JSON.parse(rawParams) : {};
const timeoutMs = Number(process.argv[4] || 15000);
const request = { id: 1, method, params };

const socket = new WebSocket("ws://127.0.0.1:62000");
const timer = setTimeout(() => {
    console.error(`Timed out waiting for ${method}`);
    socket.close();
    process.exitCode = 1;
}, timeoutMs);

socket.on("open", () => socket.send(JSON.stringify(request)));
socket.on("message", (data) => {
    const text = data.toString();
    console.log(text);
    try {
        const message = JSON.parse(text);
        if (message.id === request.id) {
            clearTimeout(timer);
            socket.close();
        }
    } catch (_) {}
});
socket.on("error", (error) => {
    clearTimeout(timer);
    console.error(error.message);
    process.exitCode = 1;
});
