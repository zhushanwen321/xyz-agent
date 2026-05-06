export type { ClientMessage, ServerMessage, SessionCreatePayload, SessionDeletePayload, SessionSwitchPayload, SessionHistoryPayload, MessageSendPayload, MessageAbortPayload, SetProviderPayload, DeleteProviderPayload, ModelSwitchPayload, SessionCreatedPayload, SessionDeletedPayload, SessionListPayload, TextDeltaPayload, ThinkingDeltaPayload, ToolCallStartPayload, ToolCallEndPayload, MessageCompletePayload, MessageErrorPayload, ProvidersPayload, ModelListPayload, ModelSwitchedPayload, ErrorPayload, Usage, } from './protocol';
export type { Message, ToolCall, ThinkingBlock, } from './message';
export type { SessionSummary, SessionGroup, } from './session';
export type { ProviderStatus, ProviderInfo, ModelInfo, } from './provider';
export interface AppError {
    message: string;
    code?: 'CONNECTION_LOST' | 'PROVIDER_ERROR' | 'SESSION_NOT_FOUND' | 'PROCESS_CRASHED' | 'TIMEOUT';
    retryable?: boolean;
}
