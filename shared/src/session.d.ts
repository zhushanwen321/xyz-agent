export interface SessionSummary {
    id: string;
    label: string;
    cwd: string;
    lastActiveAt: number;
    status: 'active' | 'idle';
}
export interface SessionGroup {
    cwd: string;
    sessions: SessionSummary[];
}
