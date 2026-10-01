import { createSolidStoreKernel } from '../../infrastructure/state/solidStoreKernel'
import { createReactStoreHook, type ZustandHook } from '../../host/reactStoreShim'

/**
 * replayPostureStore — 历史回放只读姿态（W4-02，姿态二拍板：点击行直接进 agent sheet 只读）。
 *
 * 一次性进入手势：HistorySheetView 行点击 → enter(sessionId) → AgentSheetView 以只读姿态
 * 渲染（隐藏 ControlCenter/输入面，显示「只读回放 · 点击继续」占位条）；点击占位条
 * clear() 转 live。离开该会话/关闭 sheet 由 AgentSheetView 清空，防 tab 重开误回只读。
 * 非持久化（会话恢复后即普通 live 会话）。
 */
export interface ReplayPostureState {
  sessionId: string | null
  enter: (sessionId: string) => void
  clear: () => void
}

// #515 批0：zustand → Solid 内核置换（对外签名不变；hook shim 待 React 面退役时拆除）。
const kernel = createSolidStoreKernel<ReplayPostureState>({
  sessionId: null,
  enter: sessionId => kernel.setState({ sessionId }),
  clear: () => kernel.setState({ sessionId: null }),
})

export const useReplayPostureStore: ZustandHook<ReplayPostureState> = createReactStoreHook(kernel)
