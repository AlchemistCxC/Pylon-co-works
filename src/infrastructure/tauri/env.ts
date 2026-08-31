/**
 * env — Tauri 运行时探测单点（H1）。
 *
 * 此前 App/ChatView/PetCompanion/backgroundImage/Settings 五处各自 typeof window 判断，
 * 形态不一（双条件/单条件/参数化）。统一收敛于此，探测字段变更只改一处。
 */

export type TauriWindow = { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }

// typeof window 守卫：node（legacy 测试）/SSR 环境可安全 import 本模块
export const IS_TAURI = typeof window !== 'undefined'
  && (typeof (window as unknown as TauriWindow).__TAURI_INTERNALS__ !== 'undefined' || typeof (window as unknown as TauriWindow).__TAURI__ !== 'undefined')

/** Browser demo installs a transport-compatible fake Tauri global after this
 * module is evaluated. Keep callers able to distinguish that mock at runtime. */
export function isBrowserMockRuntime(): boolean {
  return typeof window !== 'undefined'
    && (window as unknown as { __PYLON_BROWSER_MOCK__?: unknown }).__PYLON_BROWSER_MOCK__ === true
}

/** 参数化变体：对任意 window-like 对象探测（backgroundImage 本地路径转换用） */
export function hasTauriRuntime(target: TauriWindow): boolean {
  return Boolean(target.__TAURI_INTERNALS__ || target.__TAURI__)
}
