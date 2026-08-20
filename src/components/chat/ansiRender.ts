/**
 * ansiRender — ANSI 转义序列 → 已脱敏 HTML 的 legacy 查询面 facade（M8）。
 *
 * 优先走已注册 provider（core.renderer.ansi），未注册时回退 builtin
 * （Anser + htmlSanitizer，与迁移前 ToolCard 行为一致）。
 */
import Anser from 'anser'
import { sanitizeHtml } from './htmlSanitizer.ts'
import { resolveAnsiProvider } from '../../domains/rendererContent/rendererContentRegistry.ts'

/** 内置实现（core.renderer.ansi 与无插件回退共用）。 */
export function renderAnsiHtmlBuiltin(text: string): string {
  return sanitizeHtml(new Anser().ansiToHtml(Anser.escapeForHtml(text)))
}

export function renderAnsiHtml(text: string): string {
  const provider = resolveAnsiProvider(text)
  if (!provider) return renderAnsiHtmlBuiltin(text)
  return sanitizeHtml(provider.render(text))
}
