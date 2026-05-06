import { createServer } from "http";
import { WebSocketServer } from "ws";
import { createSessionRouter } from "./server.js";
// Parse --port from CLI args (provided by Tauri sidecar.rs)
const args = process.argv.slice(2);
let port = 3210;
for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
        port = parseInt(args[i + 1], 10);
        i++;
    }
}
// Create HTTP server for health checks + WS upgrade
const server = createServer((req, res) => {
    if (req.url === "/health") {
        res.writeHead(200).end("ok");
    }
    else {
        res.writeHead(404).end();
    }
});
// Create WebSocket server on the same HTTP server
const wss = new WebSocketServer({ server });
// Wire up message routing
const router = createSessionRouter();
wss.on("connection", (ws) => {
    console.log("[sidecar] client connected");
    router.handleConnection(ws);
    ws.on("close", () => {
        console.log("[sidecar] client disconnected");
    });
});
server.listen(port, () => {
    console.log(`[sidecar] listening on port ${port} (WS + HTTP /health)`);
});
