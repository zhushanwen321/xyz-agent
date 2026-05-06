export type ProviderStatus = 'connected' | 'not_configured' | 'error';
export interface ProviderInfo {
    id: string;
    name: string;
    status: ProviderStatus;
    models?: ModelInfo[];
}
export interface ModelInfo {
    id: string;
    name: string;
    providerId: string;
    tier?: 'fast' | 'standard' | 'powerful';
}
