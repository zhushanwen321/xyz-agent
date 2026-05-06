import type { WebSocket } from "ws";
export declare function createSessionRouter(): {
    handleConnection(ws: WebSocket): void;
};
