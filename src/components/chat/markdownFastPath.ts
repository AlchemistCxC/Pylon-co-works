const FENCED_CODE_PATTERN = /(^|\n)\s{0,3}(```|~~~)/
const INLINE_CODE_PATTERN = /`[^`\n]+`/
const LINK_PATTERN = /!?(?:\[[^\]\n]+\]\([^)\n]+\)|<https?:\/\/[^>\n]+>)/
const HEADING_PATTERN = /(^|\n)\s{0,3}#{1,6}\s+/
const BLOCKQUOTE_PATTERN = /(^|\n)\s{0,3}>\s?/
const UNORDERED_LIST_PATTERN = /(^|\n)\s{0,3}[-*+]\s+/
const ORDERED_LIST_PATTERN = /(^|\n)\s{0,3}\d+[.)]\s+/
const THEMATIC_BREAK_PATTERN = /(^|\n)\s{0,3}(?:\*\s*){3,}$|(^|\n)\s{0,3}(?:-\s*){3,}$|(^|\n)\s{0,3}(?:_\s*){3,}$/
const HTML_PATTERN = /<\/?[A-Za-z][^>\n]*>/
const EMPHASIS_PATTERN = /(^|[^\w])(?:\*\*|__)(?=\S)[\s\S]*?\S(?:\*\*|__)(?=$|[^\w])|(^|[^\w])(?:\*|_)(?=\S)[^\n]*?\S(?:\*|_)(?=$|[^\w])/u
const TABLE_SEPARATOR_PATTERN = /(^|\n)\s{0,3}\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*($|\n)/

/**
 * 只允许没有可识别 Markdown 结构的文本走 raw text renderer。
 * 判定必须保守：无法确认是纯文本时继续交给 ReactMarkdown。
 */
export function isPlainTextContent(content: string): boolean {
  if (!content) return true

  return ![
    FENCED_CODE_PATTERN,
    INLINE_CODE_PATTERN,
    LINK_PATTERN,
    HEADING_PATTERN,
    BLOCKQUOTE_PATTERN,
    UNORDERED_LIST_PATTERN,
    ORDERED_LIST_PATTERN,
    THEMATIC_BREAK_PATTERN,
    HTML_PATTERN,
    EMPHASIS_PATTERN,
    TABLE_SEPARATOR_PATTERN,
  ].some(pattern => pattern.test(content))
}
