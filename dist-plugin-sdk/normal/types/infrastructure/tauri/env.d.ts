/**
 * env — Tauri 运行时探测单点（H1）。
 *
 * 此前 App/ChatView/PetCompanion/backgroundImage/Settings 五处各自 typeof window 判断，
 * 形态不一（双条件/单条件/参数化）。统一收敛于此，探测字段变更只改一处。
 */
export type TauriWindow = {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
};
export declare const IS_TAURI: boolean;
/** Browser demo installs a transport-compatible fake Tauri global after this
 * module is evaluated. Keep callers able to distinguish that mock at runtime. */
export declare function isBrowserMockRuntime(): boolean;
/** 参数化变体：对任意 window-like 对象探测（backgroundImage 本地路径转换用） */
export declare function hasTauriRuntime(target: TauriWindow): boolean;
