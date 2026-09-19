/**
 * #201：sessionPrompt 注入系统的插件化贡献模型。
 *
 * 背景：首轮 prompt 的注入前缀此前是硬编码三元组（persona/snapshot 前导 + 用户
 * 会话 prompt + 命令清单块，见 `sessionRuntime.buildSendMessagePayload`）。命令块
 * 已走 v2 Command Registry（插件可贡献 `agentPromptSnippet`），但 persona/snapshot
 * 之外的扩展面不存在——将来外接 skill 清单、MCP server 描述等都需要向首轮
 * prompt 注入段落。
 *
 * 模型：每个贡献 = `{ id, target, text, order, maxBytes }`，经
 * `PromptContributionRegistry` 注册（PluginIdentity 命名空间隔离 + 校验冻结），
 * 宿主在组装 sessionPrompt 时按 `target` 过滤、按 `order` 排序、按 `maxBytes`
 * 截断。**核心段（persona/用户 sessionPrompt/命令块）不进注册表**——它们是
 * 宿主身份语义，注册表只承载可插拔扩展段。
 */

/** 注入目标。当前唯一消费面是首轮 sessionPrompt；将来扩展（如 system 角色）再加。 */
export type PromptContributionTarget = 'session-prompt'

export interface PromptContribution {
  /** 贡献 id（注册表内按 owner 命名空间隔离；非空、无首尾空白）。 */
  readonly id: string
  readonly target: PromptContributionTarget
  /**
   * 注入正文。允许为空串（组装时跳过）——动态贡献（技能清单等）可能在某时刻
   * 没有内容，注销/注册的生命周期比文本存在性粗。
   */
  readonly text: string
  /** 组装排序：小者在前。约定：扩展段 ≥ 100（核心段 identity=0/session=50 在组装侧）。 */
  readonly order: number
  /** 单段字节上限（默认/上限见 PROMPT_CONTRIBUTION_DEFAULT_MAX_BYTES）。 */
  readonly maxBytes?: number
  /** 人类可读标签（诊断/审计用）。 */
  readonly label?: string
}

export const PROMPT_CONTRIBUTION_DEFAULT_MAX_BYTES = 2048
export const PROMPT_CONTRIBUTION_HARD_MAX_BYTES = 8192

export function validatePromptContribution(contribution: PromptContribution): PromptContribution {
  if (!contribution.id || contribution.id !== contribution.id.trim()) {
    throw new Error('Prompt contribution id 非法')
  }
  if (contribution.target !== 'session-prompt') {
    throw new Error(`Prompt contribution target 非法：${String(contribution.target)}`)
  }
  if (typeof contribution.text !== 'string') {
    throw new Error(`Prompt contribution text 必须是字符串：${contribution.id}`)
  }
  if (!Number.isFinite(contribution.order)) {
    throw new Error(`Prompt contribution order 必须是有限数：${contribution.id}`)
  }
  const maxBytes = contribution.maxBytes ?? PROMPT_CONTRIBUTION_DEFAULT_MAX_BYTES
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || maxBytes > PROMPT_CONTRIBUTION_HARD_MAX_BYTES) {
    throw new Error(`Prompt contribution maxBytes 越界（0, ${PROMPT_CONTRIBUTION_HARD_MAX_BYTES}]：${contribution.id}`)
  }
  return Object.freeze({ ...contribution, maxBytes })
}
