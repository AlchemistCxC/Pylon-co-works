import SolidMount from '../host/SolidMount'

// P52 D4：React 类型图不得触碰 .solid 文件（会把 Solid JSX 拉进 React tsconfig 程序），
// 实体经 eager glob 缝加载，挂载函数接口在本文件声明。
interface ProfileEditorSolidModule {
  renderProfileEditor(container: HTMLElement, latest: () => ProfileEditorProps): () => void
}

const modules = import.meta.glob<ProfileEditorSolidModule>('./ProfileEditor.solid.tsx', { eager: true })
const solidModule = modules['./ProfileEditor.solid.tsx']
if (!solidModule) throw new Error('ProfileEditor Solid 实体未进入 Vite module graph')

/** 与 Solid 实体（ProfileEditor.solid.tsx）内声明的 ProfileEditorProps 逐字段一致。 */
export interface ProfileEditorProps {
  onClose: () => void
}

/**
 * ProfileEditor — 身份 Profile 编辑弹窗。
 * #515：实体在 ProfileEditor.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。
 */
export default function ProfileEditor(props: ProfileEditorProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderProfileEditor(container, latest)} />
}
