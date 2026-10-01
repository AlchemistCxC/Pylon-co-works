import SolidMount from '../../host/SolidMount'
import type { DispatchSelection } from '../../domains/file/dispatchMessage.ts'

/** 与 Solid 实体（DispatchBar.solid.tsx）内声明的 DispatchBarProps 逐字段一致。 */
export interface DispatchBarProps {
  targetSource: string | null
  targetSessionId?: string | null
  context?: { agentId: string; source: string } | null
  filePath: string | null
  selection: DispatchSelection | null
  /** 0-A1：编辑事实在 CM 内核——宿主经取景器给发送时刻的全文，不再传内容 state。 */
  content?: string
  getContent?: () => string
  instruction: string
  onInstructionChange: (value: string) => void
  onClearSelection: () => void
}

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface DispatchBarSolidModule {
  mountDispatchBar: (container: HTMLElement, latest: () => DispatchBarProps) => () => void
}

const modules = import.meta.glob<DispatchBarSolidModule>('./DispatchBar.solid.tsx', { eager: true })
const solidModule = modules['./DispatchBar.solid.tsx']
if (!solidModule) throw new Error('DispatchBar Solid 实体未进入 Vite module graph')

export { resolveDispatchOwnerSession } from './dispatchOwnerSession.ts'

/**
 * DispatchBar — 发令指令栏（W2-08，§4.1）。
 *
 * 选区事实来自 CM 内核 KernelSummary（0-A1 起旧 DOM data-line 捕获随投影退役）；
 * 发送调 send_message 显式 source + persona:''；
 * 调用发出后（invoke 同步创建成功）清 instruction 保留选区；错误内联。目标会话
 * 生成中仅提示不禁用（send_message 阻塞语义由后端串行化）。
 *
 * OWNER-02（§5.8）：send_message 载荷携带显式 agentId——优先取 context（sheet 绑定
 * Agent，I01-W3）；context 缺失时回退 Session owner（identityStore 中 source 唯一命中）；
 * 仍无法确定则拒绝发送（不串线）。
 * #515：实体在 DispatchBar.solid.tsx（`resolveDispatchOwnerSession` 纯函数下沉
 * dispatchOwnerSession.ts 单源共享），本文件是 React 世界薄桥（批7 拆除）。
 */
export default function DispatchBar(props: DispatchBarProps) {
  return <SolidMount initial={props} mount={solidModule.mountDispatchBar} />
}
