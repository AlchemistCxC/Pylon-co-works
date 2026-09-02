import type { SheetId } from './sheetTypes.js';
type WorkspaceLiveCloseGuard = () => boolean | Promise<boolean>;
/**
 * Registers a close decision backed by live, non-serializable UI state such as
 * an editor draft. Workspace definition codecs cannot represent that state.
 */
export declare function registerWorkspaceLiveCloseGuard(id: SheetId, guard: WorkspaceLiveCloseGuard): () => void;
export declare function canCloseWorkspaceLiveState(id: SheetId): Promise<boolean>;
export {};
