import SolidMount from '../../host/SolidMount'
import { FILE_CODE_TAB_SIZE_FALLBACK, resolveTabSize, type FileCodeEditorApi, type KernelSummary } from './fileCodeMirrorKernel.ts'

/**
 * FileCodeEditorProps — 与 Solid 实体（FileCodeEditor.solid.tsx）内声明的同名接口逐字段
 * 一致，唯 `editable` 是 React 壳面的历史命名（桥内映射为实体的 `writable`）。
 */
export interface FileCodeEditorProps {
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
}

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface FileCodeEditorSolidModule {
  mountFileCodeEditor: (container: HTMLElement, latest: () => {
    path: string
    initialContent: string
    baseline: string
    writable?: boolean
    revealLine?: number
    onSummaryChange?: (summary: KernelSummary) => void
    onSave?: () => void
    apiRef?: { current: FileCodeEditorApi | null }
  }) => () => void
}

const modules = import.meta.glob<FileCodeEditorSolidModule>('./FileCodeEditor.solid.tsx', { eager: true })
const solidModule = modules['./FileCodeEditor.solid.tsx']
if (!solidModule) throw new Error('FileCodeEditor Solid 实体未进入 Vite module graph')

export { FILE_CODE_TAB_SIZE_FALLBACK, resolveTabSize }
export type { FileCodeEditorApi, KernelSummary }

/**
 * FileCodeEditor — React 适配器（薄壳）。
 *
 * 内核实体在 fileCodeMirrorKernel.ts（框架无关工厂，与 Solid 实体
 * FileCodeEditor.solid.tsx 共享同一行为事实——#279 双渲染器同构纪律 + 0-A1 单内核）。
 * FileTabView 以 path 作为 key；单个实例只对应一个文档与语言生命周期。
 * #515：实体在 FileCodeEditor.solid.tsx，本文件是 React 世界薄桥（批7 拆除）；
 * `editable` 在桥内映射为实体的 `writable`（两者缺省皆 true，语义同构）。
 */
export default function FileCodeEditor(props: FileCodeEditorProps) {
  return (
    <SolidMount
      initial={props}
      mount={(container, latest) => solidModule.mountFileCodeEditor(container, () => {
        const react = latest()
        return {
          path: react.path,
          initialContent: react.initialContent,
          baseline: react.baseline,
          writable: react.editable,
          revealLine: react.revealLine,
          onSummaryChange: react.onSummaryChange,
          onSave: react.onSave,
          apiRef: react.apiRef,
        }
      })}
    />
  )
}
