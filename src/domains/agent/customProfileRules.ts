/**
 * B1：自定义 Agent profile 的创建规则（复用 Codeg custom_registry 的规则类别）。
 *
 * 规则四类，全部前端可判（后端另有同款 slug 校验与重复 id 拒绝，见
 * `agent_config::patch::validate_agent_id` / `apply_agent_create`）：
 * - slug/id 校验：与后端同一正则；
 * - 内置 id 冲突：id 借用 catalog 内置 provider 名而 provider 另指他处——
 *   Codeg 拒绝自定义 registry id 与内置 id 碰撞（from_registry_id 解析内置
 *   优先）；Pylon 的等价危害是 provider 策略按 provider 名查 catalog，
 *   id 与 provider 名不一致时身份说明自相矛盾。id 与 provider 同名（导入
 *   内置 provider 的正常路径）不触发；
 * - 必填 launch：name/exe 必填（transport 由创建通道固定为 subprocess）；
 * - 字段封闭：创建表单只允许已知字段键，未知键在构造期即不存在（锁定为
 *   断言而不是约定）。
 */

export interface CustomProfileIssue {
  code: 'invalid_id' | 'duplicate_id' | 'builtin_id_conflict' | 'missing_name' | 'missing_exe'
  message: string
}

const AGENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export function isValidAgentIdPattern(id: string): boolean {
  return AGENT_ID_PATTERN.test(id)
}

export function validateCustomProfile(
  input: { id: string; name: string; exe: string; provider: string },
  existingAgentIds: readonly string[],
  builtinProviderIds: readonly string[],
): CustomProfileIssue[] {
  const issues: CustomProfileIssue[] = []
  const id = input.id.trim()
  if (id.length === 0 || !isValidAgentIdPattern(id)) {
    issues.push({
      code: 'invalid_id',
      message: `Agent id ${JSON.stringify(id)} 非法（须匹配 ^[a-zA-Z0-9][a-zA-Z0-9._-]*$）`,
    })
  }
  if (existingAgentIds.includes(id)) {
    issues.push({ code: 'duplicate_id', message: `Agent id ${id} 已存在（新建不可覆盖）` })
  }
  const normalizedProvider = input.provider.trim().toLowerCase()
  const idBorrowsBuiltinName =
    id.length > 0
    && builtinProviderIds.some(provider => provider.toLowerCase() === id.toLowerCase())
    && normalizedProvider.length > 0
    && normalizedProvider !== id.toLowerCase()
  if (idBorrowsBuiltinName) {
    issues.push({
      code: 'builtin_id_conflict',
      message: `id ${id} 与内置 provider 同名，但 provider 指向 ${normalizedProvider}；请让 id 与 provider 一致，或换一个 id`,
    })
  }
  if (input.name.trim().length === 0) {
    issues.push({ code: 'missing_name', message: '新建 Agent 必须填写 name' })
  }
  if (input.exe.trim().length === 0) {
    issues.push({ code: 'missing_exe', message: '新建 Agent 必须填写可执行文件（exe）' })
  }
  return issues
}

/** 创建表单允许写出的字段键（封闭词表；未知键在构造期即不存在）。 */
export const CUSTOM_PROFILE_FIELD_WHITELIST: readonly string[] = Object.freeze([
  'name',
  'provider',
  'transport',
  'exe',
  'args',
  'default',
])

export function assertCustomProfileFieldsAllowed(config: Record<string, unknown>): void {
  for (const key of Object.keys(config)) {
    if (!CUSTOM_PROFILE_FIELD_WHITELIST.includes(key)) {
      throw new Error(`自定义 Agent 配置出现未知字段：${key}`)
    }
  }
}
