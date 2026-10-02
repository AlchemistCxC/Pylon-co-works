/**
 * Solid 测试统一等待原语（#520 R2 测试基建收敛）。
 *
 * Solid 无 act：RTL act() 微任务冲刷的隐式时序在 Solid 无等价物（#515 分诊 17 测试
 * 竞态的统一根因），各测试文件等待微任务/帧的裸字面量与本地重复实现在此收敛为
 * 单一预算。2s 预算的负载依据见 #515 批8/二轮记录
 * （`.agents/records/515-frontend-solid-endgame-execution.md`）。
 *
 * 注意：只收「冲刷预算」一档——等待真实异步链（wasm 解析、IPC）的长预算不属此类，
 * 各测试文件保留其原有更大字面量。
 */

/** waitFor/findBy 的统一冲刷预算：Solid 无 act，等待微任务/帧的统一预算；2s 的负载依据见 #515 批8/二轮记录。 */
export const FLUSH_BUDGET = { timeout: 2_000 } as const

/** 让出一个宏任务：Solid 信号写入同步落盘，迟到结果续延（如异步回调续写信号）只需一次宏任务冲刷。 */
export const flushTask = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** 等待下一帧（rAF 包裹）：断言对象跨过一次渲染帧后再取值。 */
export const nextFrame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => resolve()))
