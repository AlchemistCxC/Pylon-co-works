/**
 * devTriggerKit — DEV 取证控制台钩子的公共安装样板（结构审查 B-10）。
 *
 * obs04~07 四个钩子曾各写一份「window 守卫 + IS_TAURI 守卫 + 防重入」；统一在此。
 * 挂载仍由 main.tsx 在 DEV 构建动态 import（生产 tree-shake，零暴露），本文件不改变该设计。
 */
import { IS_TAURI } from '../../infrastructure/tauri/env'

/** 幂等安装：key 未占用时以 build() 产物挂上 window 并返回 true。浏览器 mock / 产物构建 no-op。 */
export function mountDevConsoleApi<T>(key: string, build: () => T): boolean {
  if (typeof window === 'undefined') return false
  if (!IS_TAURI) return false
  const win = window as unknown as Record<string, unknown>
  if (win[key]) return false
  win[key] = build()
  return true
}
