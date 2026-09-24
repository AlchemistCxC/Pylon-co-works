import { useEffect, useRef } from 'react'
import { createFileCodeMirrorKernel, FILE_CODE_TAB_SIZE_FALLBACK, resolveTabSize, type FileCodeEditorApi, type FileCodeMirrorKernel, type KernelSummary } from './fileCodeMirrorKernel.ts'

/**
 * FileCodeEditor — React 适配器（薄壳）。
 *
 * 内核实体在 fileCodeMirrorKernel.ts（框架无关工厂，与 Solid 适配器
 * FileCodeEditor.solid.tsx 共享同一行为事实——#279 双渲染器同构纪律 + 0-A1 单内核）。
 * 本壳只做 React 生命周期桥接：mount 创建内核，baseline/editable/revealLine 的
 * 后续变化经内核可变方法下传。FileTabView 以 path 作为 key；单个实例只对应一个
 * 文档与语言生命周期。
 */
export default function FileCodeEditor({ path, initialContent, baseline, editable = true, revealLine, onSummaryChange, onSave, apiRef }: {
  path: string
  /** 首次构造的文档内容；此后宿主经 api.replaceDoc 做外部替换，不再有 value prop。 */
  initialContent: string
  /** 磁盘锚点（保存成功/重载后由宿主推进）；内核据此计算 dirty。 */
  baseline: string
  editable?: boolean
  revealLine?: number
  onSummaryChange?: (summary: KernelSummary) => void
  onSave?: () => void
  apiRef?: { current: FileCodeEditorApi | null }
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const kernelRef = useRef<FileCodeMirrorKernel | null>(null)
  const callbacksRef = useRef({ onSummaryChange, onSave })
  callbacksRef.current = { onSummaryChange, onSave }

  useEffect(() => {
    const parent = hostRef.current
    if (!parent) return
    const kernel = createFileCodeMirrorKernel(parent, {
      path,
      initialContent,
      baseline,
      editable,
      callbacks: {
        onSummaryChange: summary => callbacksRef.current.onSummaryChange?.(summary),
        onSave: () => callbacksRef.current.onSave?.(),
      },
    })
    kernelRef.current = kernel
    if (apiRef) apiRef.current = kernel.api

    return () => {
      kernelRef.current = null
      if (apiRef) apiRef.current = null
      kernel.destroy()
    }
    // 单实例只对应一个文档与语言生命周期（key 由宿主承载）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 磁盘锚点推进（保存回执）：内核内 O(结构) 重算 dirty 并发摘要。
  useEffect(() => {
    kernelRef.current?.setBaseline(baseline)
  }, [baseline])

  // editable 翻转：readonly compartment reconfigure（创建时已按初值装配）。
  useEffect(() => {
    kernelRef.current?.setEditable(editable)
  }, [editable])

  useEffect(() => {
    kernelRef.current?.reveal(revealLine)
  }, [revealLine])

  return <div ref={hostRef} className="file-code-editor" data-file-code-layout="shared" data-path={path} />
}

export { FILE_CODE_TAB_SIZE_FALLBACK, resolveTabSize }
export type { FileCodeEditorApi, KernelSummary }
