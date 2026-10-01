import SolidMount from '../host/SolidMount'

// P52 D4：React 类型图不得触碰 .solid 文件（会把 Solid JSX 拉进 React tsconfig 程序），
// 实体经 eager glob 缝加载，挂载函数接口在本文件声明。
interface SessionOwnerRecoveryDialogSolidModule {
  renderSessionOwnerRecoveryDialog(container: HTMLElement, latest: () => Record<string, never>): () => void
}

const modules = import.meta.glob<SessionOwnerRecoveryDialogSolidModule>('./SessionOwnerRecoveryDialog.solid.tsx', { eager: true })
const solidModule = modules['./SessionOwnerRecoveryDialog.solid.tsx']
if (!solidModule) throw new Error('SessionOwnerRecoveryDialog Solid 实体未进入 Vite module graph')

/**
 * SessionOwnerRecoveryDialog — 遗留会话归属恢复弹窗（ISSUE-01）。
 * #515：实体在 SessionOwnerRecoveryDialog.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。
 */
export default function SessionOwnerRecoveryDialog() {
  return <SolidMount initial={{}} mount={(container, latest) => solidModule.renderSessionOwnerRecoveryDialog(container, latest)} />
}
