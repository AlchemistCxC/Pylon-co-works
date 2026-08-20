/**
 * skinValidation — Skin Draft 结构化校验（阶段 5 S5-B）。
 *
 * 校验只依赖 SkinSchema 纯数据，不触碰 Store/DOM。
 * css 安全规则采用最小 contract：限制长度、拒绝 @import/url()/expression 与
 * html/body/:root/* 顶层根选择器。复杂 CSS 沙箱不在本阶段冒充。
 */
import type {
  SkinDraft,
  SkinSchema,
  SkinValidationIssue,
  SkinValidationResult,
} from './skinTypes.ts'

export const SKIN_CSS_MAX_LENGTH = 8000

function issue(
  path: string,
  code: SkinValidationIssue['code'],
  message: string,
  expected?: unknown,
  actual?: unknown,
): SkinValidationIssue {
  const result: SkinValidationIssue = { path, code, message }
  if (expected !== undefined) result.expected = expected
  if (actual !== undefined) result.actual = actual
  return result
}

function validateTokenValue(
  key: string,
  value: unknown,
  schema: SkinSchema,
  issues: SkinValidationIssue[],
): void {
  const field = schema.fields[key]
  if (!field) {
    issues.push(issue(`tokens.${key}`, 'unknown-token', `未知 token：${key}`))
    return
  }

  switch (field.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push(issue(`tokens.${key}`, 'invalid-type', `${key} 必须是有限 number`, 'number', typeof value))
        return
      }
      if (field.min !== undefined && value < field.min) {
        issues.push(issue(`tokens.${key}`, 'number-out-of-range', `${key} 小于最小值`, { min: field.min }, value))
      }
      if (field.max !== undefined && value > field.max) {
        issues.push(issue(`tokens.${key}`, 'number-out-of-range', `${key} 大于最大值`, { max: field.max }, value))
      }
      return
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        issues.push(issue(`tokens.${key}`, 'invalid-type', `${key} 必须是 boolean`, 'boolean', typeof value))
      }
      return
    }
    case 'select': {
      const options = field.options ?? []
      // 历史字段混用：defs 中 select + boolean default 的字段接受 boolean 或枚举值。
      const booleanCompatible = typeof field.default === 'boolean'
      if (typeof value === 'boolean' && booleanCompatible) return
      if (typeof value === 'string' && options.includes(value)) return
      issues.push(issue(`tokens.${key}`, 'invalid-option', `${key} 不是合法选项`, options, value))
      return
    }
    case 'color':
    case 'text': {
      if (typeof value !== 'string') {
        issues.push(issue(`tokens.${key}`, 'invalid-type', `${key} 必须是 string`, 'string', typeof value))
      }
      return
    }
    default: {
      issues.push(issue(`tokens.${key}`, 'invalid-type', `${key} 类型无法校验`, undefined, value))
    }
  }
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function isRootSelector(selector: string): boolean {
  const trimmed = selector.trim()
  if (!trimmed) return false
  const firstToken = trimmed.split(/\s+/)[0]
  return firstToken === 'html' || firstToken === 'body' || firstToken === ':root' || firstToken === '*'
}

function validateCss(css: string, issues: SkinValidationIssue[]): void {
  if (css.length > SKIN_CSS_MAX_LENGTH) {
    issues.push(issue('css', 'css-too-long', `CSS 超过长度限制 ${SKIN_CSS_MAX_LENGTH}`, { max: SKIN_CSS_MAX_LENGTH }, css.length))
  }
  if (/<\/style/i.test(css)) {
    issues.push(issue('css', 'invalid-css', 'CSS 不得包含 </style> 标签'))
  }
  if (/@import/i.test(css)) {
    issues.push(issue('css', 'invalid-css', 'CSS 不得包含 @import'))
  }
  if (/url\s*\(/i.test(css)) {
    issues.push(issue('css', 'invalid-css', 'CSS 不得包含 url() 资源加载'))
  }
  if (/expression\s*\(/i.test(css)) {
    issues.push(issue('css', 'invalid-css', 'CSS 不得包含 expression()'))
  }

  const body = stripCssComments(css)
  for (const block of body.split('}')) {
    const openBrace = block.indexOf('{')
    if (openBrace < 0) continue
    const selectorList = block.slice(0, openBrace)
    for (const rawSelector of selectorList.split(',')) {
      if (isRootSelector(rawSelector)) {
        issues.push(issue('css', 'css-root-selector', `CSS 不允许根选择器：${rawSelector.trim()}`, undefined, rawSelector.trim()))
      }
    }
  }
}

function validateAssets(assets: Record<string, unknown>, issues: SkinValidationIssue[]): void {
  for (const [key, value] of Object.entries(assets)) {
    if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string') {
      issues.push(issue(`assets.${key}`, 'invalid-type', 'asset 必须为包含字符串 id 的对象', 'SkinAssetRef', value))
    }
  }
}

export function isValidSkinToken(key: string, value: unknown, schema: SkinSchema): boolean {
  const issues: SkinValidationIssue[] = []
  validateTokenValue(key, value, schema, issues)
  return issues.length === 0
}

export function isValidSkinVariant(component: string, value: string, schema: SkinSchema): boolean {
  const allowed = schema.componentVariants[component]
  return Boolean(allowed?.includes(value))
}

export function isValidSkinCss(css: string): boolean {
  const issues: SkinValidationIssue[] = []
  validateCss(css, issues)
  return issues.length === 0
}

export function validateSkinDraft(draft: SkinDraft, schema: SkinSchema): SkinValidationResult {
  const issues: SkinValidationIssue[] = []

  for (const [key, value] of Object.entries(draft.tokens)) {
    validateTokenValue(key, value, schema, issues)
  }

  for (const [component, variant] of Object.entries(draft.variants)) {
    const allowed = schema.componentVariants[component]
    if (!allowed) {
      issues.push(issue(`variants.${component}`, 'unknown-token', `未知组件：${component}`))
      continue
    }
    if (!allowed.includes(variant)) {
      issues.push(issue(`variants.${component}`, 'invalid-option', `${component} 不是合法 variant`, allowed, variant))
    }
  }

  if (draft.css !== undefined) {
    if (typeof draft.css !== 'string') {
      issues.push(issue('css', 'invalid-type', 'css 必须是 string', 'string', typeof draft.css))
    } else {
      validateCss(draft.css, issues)
    }
  }

  validateAssets(draft.assets, issues)

  return { valid: issues.length === 0, issues }
}
