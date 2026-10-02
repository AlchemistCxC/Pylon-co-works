/** @jsxImportSource solid-js */
import { createEffect, ErrorBoundary, on } from 'solid-js'
import type { JSX } from 'solid-js'

/**
 * FileViewRenderBoundaryProps — 与 React 原件（FileViewRenderBoundary.tsx）逐字段一致。
 */
export interface FileViewRenderBoundaryProps {
  rendererId: string
  onError: (error: unknown) => 'fallback' | 'rethrow'
  onFallback: (rendererId: string) => void
  children?: JSX.Element
}

/**
 * FileViewRenderBoundary — 把坏掉的 renderer 局限在其 tab 内，让宿主选择下一 renderer
 * （#515 Solid 实体；React class 原件保留在 FileViewRenderBoundary.tsx——其 children
 * 按红线不跨 React/Solid 桥，原件随批7 与 React 世界一并退役）。
 *
 * 语义与 React 版逐项同构：错误 → onError 裁决；fallback → onFallback(rendererId) 并
 * 展示切换提示；rethrow → 向上重抛。rendererId 变化（宿主已换 renderer）→ 清错误态
 * 重渲染子树（React componentDidUpdate 同语义）。
 */
export default function FileViewRenderBoundary(props: FileViewRenderBoundaryProps) {
  let resetBoundary: (() => void) | null = null

  createEffect(on(() => props.rendererId, () => {
    resetBoundary?.()
    resetBoundary = null
  }))

  return (
    <ErrorBoundary fallback={(error, reset) => {
      resetBoundary = reset
      const decision = props.onError(error)
      if (decision === 'rethrow') throw error
      props.onFallback(props.rendererId)
      return <div class="file-tab-empty">正在切换到备用文件视图…</div>
    }}>
      {props.children}
    </ErrorBoundary>
  )
}
