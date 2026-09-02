export type RightPanelTab = 'workspace' | 'logs' | 'activity' | 'changes';
export interface RightPanelTabDefinition {
    id: RightPanelTab;
    label: string;
}
export interface PanelStatusProps {
    kind: 'loading' | 'empty' | 'error';
    title: string;
    detail?: string;
    retry?: () => void;
}
/** Backend-agnostic data used to render the Workspace tree. */
export interface WorkspaceEntry {
    path: string;
    label: string;
    kind: 'file' | 'folder';
    expandable?: boolean;
    entries?: readonly WorkspaceEntry[];
}
export interface WorkspaceTextPreview {
    relativePath: string;
    content: string;
    bytesRead: number;
    totalBytes: number;
    truncated: boolean;
    encoding: string;
}
export interface WorkspaceTree {
    entries: readonly WorkspaceEntry[];
    selectedPath: string | null;
}
export type WorkspaceViewState = {
    status: 'no-session';
} | {
    status: 'unwired';
} | {
    status: 'loading';
    tree?: WorkspaceTree;
} | {
    status: 'empty';
    tree: WorkspaceTree;
} | {
    status: 'ready';
    tree: WorkspaceTree;
    selectedText?: WorkspaceTextPreview;
} | {
    status: 'error';
    message: string;
    tree?: WorkspaceTree;
    selectedText?: WorkspaceTextPreview;
};
export type WorkspaceViewEvent = {
    type: 'begin-loading';
} | {
    type: 'loaded';
    tree: WorkspaceTree;
} | {
    type: 'loaded-text';
    text: WorkspaceTextPreview;
} | {
    type: 'failed';
    message: string;
} | {
    type: 'clear-session';
} | {
    type: 'select';
    path: string | null;
};
export declare function createWorkspaceViewState(sessionId: string | null): WorkspaceViewState;
export declare function transitionWorkspaceView(state: WorkspaceViewState, event: WorkspaceViewEvent): WorkspaceViewState;
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogsScope {
    sessionId: string;
    source: string;
}
/** Minimal, backend-agnostic data used to render one log row. */
export interface LogEntry {
    id: string;
    time: string;
    level: LogLevel;
    source: string;
    message: string;
}
export interface LogsView {
    entries: readonly LogEntry[];
}
export type LogsViewState = {
    status: 'no-session';
} | {
    status: 'unwired';
    scope: LogsScope;
} | {
    status: 'loading';
    scope: LogsScope;
    view?: LogsView;
} | {
    status: 'empty';
    scope: LogsScope;
    view: LogsView;
} | {
    status: 'ready';
    scope: LogsScope;
    view: LogsView;
} | {
    status: 'error';
    scope: LogsScope;
    message: string;
    view?: LogsView;
};
export type LogsViewEvent = {
    type: 'begin-loading';
} | {
    type: 'loaded';
    entries: readonly LogEntry[];
} | {
    type: 'failed';
    message: string;
} | {
    type: 'set-scope';
    scope: LogsScope;
} | {
    type: 'clear-session';
};
export declare function createLogsViewState(scope: LogsScope | null): LogsViewState;
export declare function transitionLogsView(state: LogsViewState, event: LogsViewEvent): LogsViewState;
