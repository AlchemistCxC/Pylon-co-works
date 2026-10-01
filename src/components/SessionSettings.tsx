import SolidMount from '../host/SolidMount'

// P52 D4：React 类型图不得触碰 .solid 文件（会把 Solid JSX 拉进 React tsconfig 程序），
// 实体经 eager glob 缝加载，挂载函数接口在本文件声明。
interface SessionSettingsSolidModule {
  renderSessionSettings(container: HTMLElement, latest: () => SessionSettingsProps): () => void
}

const modules = import.meta.glob<SessionSettingsSolidModule>('./SessionSettings.solid.tsx', { eager: true })
const solidModule = modules['./SessionSettings.solid.tsx']
if (!solidModule) throw new Error('SessionSettings Solid 实体未进入 Vite module graph')

/** 与 Solid 实体（SessionSettings.solid.tsx）内声明的 SessionSettingsProps 逐字段一致。 */
export interface SessionSettingsProps { sessionId: string; open: boolean; onClose: () => void; onDeleted?: () => void }

/**
 * SessionSettings — 会话设置弹窗。
 * #515：实体在 SessionSettings.solid.tsx（radix Dialog 已由手写最小 Solid 等价替代），
 * 本文件是 React 世界薄桥（批7 拆除）。
 */
export default function SessionSettings(props: SessionSettingsProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderSessionSettings(container, latest)} />
}
