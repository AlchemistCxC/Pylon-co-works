/**
 * prediction — 输入预测 port 契约（结构审查 B-6）。
 *
 * 领域（settings 纯函数 + router 策略）与基础设施（HTTP provider / 调度器）都从
 * 这里取 port 形状，消除「域 import 渲染器实现文件」的倒挂。
 */

export interface InputPredictionRequest {
  readonly sessionId: string
  readonly generation?: number
  readonly draft: string
  readonly history: readonly string[]
  /** Canonical bounded conversation transcript (assistant + user turns). */
  readonly messages?: readonly { role: 'user' | 'assistant'; content: string }[]
  readonly signal: AbortSignal
}

export interface InputPredictionProvider {
  predict(request: InputPredictionRequest): Promise<string | null>
}

export interface PredictionHttpPayload {
  readonly sessionId: string
  readonly generation?: number
  readonly draft: string
  readonly history: readonly string[]
  readonly messages?: readonly { role: 'user' | 'assistant'; content: string }[]
}
