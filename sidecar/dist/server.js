export function createSessionRouter() {
    function send(ws, msg) {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }
    return {
        handleConnection(ws) {
            ws.on("message", (raw) => {
                const msg = JSON.parse(raw.toString());
                console.log("[sidecar] received:", msg.type);
                switch (msg.type) {
                    case "ping":
                        send(ws, { type: "pong", id: msg.id });
                        break;
                    case "session.list":
                        // TODO (Plan 04): implement session pool
                        send(ws, {
                            type: "session.list",
                            id: msg.id,
                            payload: { groups: [] },
                        });
                        break;
                    case "model.list":
                        // TODO (Plan 04): query pi subprocess
                        send(ws, {
                            type: "model.list",
                            id: msg.id,
                            payload: { models: [] },
                        });
                        break;
                    case "config.getProviders":
                        // TODO (Plan 04): read provider store
                        send(ws, {
                            type: "config.providers",
                            id: msg.id,
                            payload: { providers: [] },
                        });
                        break;
                    default:
                        console.log("[sidecar] unhandled message type:", msg.type);
                        send(ws, {
                            type: "error",
                            id: msg.id,
                            payload: { message: `Unknown type: ${msg.type}` },
                        });
                }
            });
        },
    };
}
