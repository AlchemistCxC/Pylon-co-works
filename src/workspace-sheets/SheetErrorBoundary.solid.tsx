/** @jsxImportSource solid-js */
import { reportRuntimeDiagnostic, resolveRuntimeErrors } from '../app/runtimeError.ts'
import { ErrorBoundary, type JSX } from 'solid-js'

interface SheetErrorBoundaryProps { children: JSX.Element; sheetId: string }

/**
 * SheetErrorBoundary — Sheet 级错误隔离（报告 8.2）。
 *
 * 单个 Sheet 渲染异常只隔离自身（retry/reset），不拖垮整个应用
 * （应用级边界由 KernelRoot.solid 兜底）。#515：React class 边界 → solid ErrorBoundary，
 * fallback DOM（role=alert / 类名 / 按钮文案）逐字节保持。
 */
export default function SheetErrorBoundary(props: SheetErrorBoundaryProps) {
  // componentDidCatch 语义：每个错误实例只报一次（fallback 函数可能随响应式更新重跑）。
  let reported: unknown
  return (
    <ErrorBoundary fallback={(error, reset) => {
      if (reported !== error) {
        reported = error
        reportRuntimeDiagnostic('Sheet 渲染失败', error, undefined, {
          key: `sheet-render:${props.sheetId}`,
          scope: { kind: 'sheet', id: props.sheetId },
          source: 'sheet.boundary',
        })
      }
      return (
        <div class="sheet-empty-host" role="alert">
          <div class="sheet-empty-kicker">SHEET ERROR</div>
          <h2>此 Sheet 渲染失败</h2>
          <p>{error.message}</p>
          <button type="button" class="template-apply" onClick={() => {
            resolveRuntimeErrors({ key: `sheet-render:${props.sheetId}` })
            reset()
          }}>重试</button>
        </div>
      )
    }}>
      {props.children}
    </ErrorBoundary>
  )
}
