import type { SessionSummary } from './session.js';
export interface ClientMessage {
    type: string;
    id?: string;
    payload?: unknown;
}
export interface SessionCreatePayload {
    cwd?: string;
}
export interface SessionDeletePayload {
    sessionId: string;
}
export interface SessionSwitchPayload {
    sessionId: string;
}
export interface SessionHistoryPayload {
    sessionId: string;
}
export interface MessageSendPayload {
    sessionId: string;
    content: string;
}
export interface MessageAbortPayload {
    sessionId: string;
}
export interface SetProviderPayload {
    providerId: string;
    apiKey?: string;
    baseUrl?: string;
}
export interface DeleteProviderPayload {
    providerId: string;
}
export interface ModelSwitchPayload {
    sessionId: string;
    modelId: string;
}
export interface ServerMessage {
    type: string;
    id?: string;
    payload?: unknown;
}
export interface SessionCreatedPayload {
    sessionId: string;
    label: string;
    cwd: string;
}
export interface SessionDeletedPayload {
    sessionId: string;
}
export interface SessionListPayload {
    groups: Array<{
        cwd: string;
        sessions: SessionSummary[];
    }>;
}
export interface TextDeltaPayload {
    sessionId: string;
    delta: string;
}
export interface ThinkingDeltaPayload {
    sessionId: string;
    delta: string;
}
export interface ToolCallStartPayload {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    input: string;
}
export interface ToolCallEndPayload {
    sessionId: string;
    toolCallId: string;
    output: string;
}
export interface MessageCompletePayload {
    sessionId: string;
    stopReason: string;
    usage?: Usage;
}
export interface MessageErrorPayload {
    sessionId: string;
    error: string;
}
export interface ProvidersPayload {
    providers: import('./provider').ProviderInfo[];
}
export interface ModelListPayload {
    models: import('./provider').ModelInfo[];
}
export interface ModelSwitchedPayload {
    sessionId: string;
    modelId: string;
}
export interface ErrorPayload {
    message: string;
    code?: string;
}
export interface Usage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}
