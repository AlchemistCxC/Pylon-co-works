/**
 * hydrationState — 应用启动 hydration 状态（报告阶段 2 / FE-AUD-005）。
 *
 * idle/loading/ready/degraded/fatal 五态：
 * - idle：尚未启动 bootstrap
 * - loading：bootstrap 进行中（迁移配置 → hydrate domains → 获取 agents）
 * - ready：bootstrap 完成，业务可用
 * - degraded：Agent 列表/listener/本地数据恢复失败——本地工作区保留，可重试
 * - fatal：不可恢复（保留位；当前无触发路径）
 */
import { createSolidStoreKernel, type SolidStoreKernel } from '../../infrastructure/state/solidStoreKernel'

export type HydrationStatus = 'idle' | 'loading' | 'ready' | 'degraded' | 'fatal'

interface HydrationState {
  status: HydrationStatus
  error: string | null
  retryCount: number
  setStatus: (status: HydrationStatus, error?: string | null) => void
  reset: () => void
}

// #515 批0：zustand → Solid 内核置换；W3 起 useHydrationStore 即内核本体（直连，无 shim）。
const kernel = createSolidStoreKernel<HydrationState>({
  status: 'idle',
  error: null,
  retryCount: 0,
  setStatus: (status, error = null) => kernel.setState(state => ({
    status,
    error,
    retryCount: status === 'degraded' ? state.retryCount + 1 : state.retryCount,
  })),
  reset: () => kernel.setState({ status: 'idle', error: null, retryCount: 0 }),
})

export const useHydrationStore: SolidStoreKernel<HydrationState> = kernel
