const ALLOWED_TAGS = new Set(['span', 'code', 'pre', 'br', 'div'])
const DROP_CONTENT_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'applet',
  'noscript',
  'template',
  'textarea',
  'title',
])
const VOID_TAGS = new Set(['br'])
const ALLOWED_ATTRIBUTES = new Set(['class', 'title', 'aria-hidden', 'role'])
const SAFE_CLASS = /^(?:pl-[A-Za-z0-9_-]+|term(?:-[A-Za-z0-9_-]+)?)$/
const SAFE_ATTRIBUTE_VALUE = /^[^<>]*$/

function escapeText(value: string): string {
  // Keep already-escaped entities intact while escaping actual markup characters.
  return value.replace(/&(?!(?:#(?:x[\da-fA-F]+|\d+)|[A-Za-z][A-Za-z\d]+);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function sanitizeClass(value: string): string | null {
  const classes = value.split(/\s+/).filter(Boolean).filter(className => SAFE_CLASS.test(className))
  return classes.length > 0 ? classes.join(' ') : null
}

function sanitizeAttributes(source: string): string {
  const attributes: string[] = []
  const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let match: RegExpExecArray | null

  while ((match = attributePattern.exec(source)) !== null) {
    const name = match[1].toLowerCase()
    if (!ALLOWED_ATTRIBUTES.has(name) || name.startsWith('on') || name === 'style') continue

    const value = match[2] ?? match[3] ?? match[4] ?? ''
    if (!SAFE_ATTRIBUTE_VALUE.test(value)) continue

    if (name === 'class') {
      const classValue = sanitizeClass(value)
      if (classValue) attributes.push(`class="${escapeAttribute(classValue)}"`)
      continue
    }

    attributes.push(`${name}="${escapeAttribute(value)}"`)
  }

  return attributes.length > 0 ? ` ${attributes.join(' ')}` : ''
}

function hasDroppedContent(stack: string[]): boolean {
  return stack.some(tagName => DROP_CONTENT_TAGS.has(tagName))
}

function findTagEnd(source: string, start: number): number {
  let quote = ''
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (character === quote) quote = ''
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      return index
    }
  }
  return -1
}

/**
 * Sanitize the restricted HTML emitted by chat rendering.
 * This function returns HTML for a sink that is separately responsible for rendering it.
 */
export function sanitizeHtml(input: string): string {
  const source = String(input ?? '')
  const output: string[] = []
  const stack: string[] = []
  let cursor = 0

  while (cursor < source.length) {
    const tagStart = source.indexOf('<', cursor)
    if (tagStart === -1) {
      if (!hasDroppedContent(stack)) output.push(escapeText(source.slice(cursor)))
      break
    }

    if (!hasDroppedContent(stack)) output.push(escapeText(source.slice(cursor, tagStart)))

    const commentEnd = source.indexOf('-->', tagStart + 4)
    if (source.startsWith('<!--', tagStart) && commentEnd !== -1) {
      cursor = commentEnd + 3
      continue
    }

    const tagEnd = findTagEnd(source, tagStart)
    if (tagEnd === -1) {
      if (stack.length === 0) output.push(escapeText(source.slice(tagStart)))
      break
    }

    const rawTag = source.slice(tagStart + 1, tagEnd)
    const closingMatch = /^\s*\/\s*([A-Za-z][\w:-]*)/.exec(rawTag)
    const openingMatch = /^\s*([A-Za-z][\w:-]*)([\s\S]*?)(\/\s*)?$/.exec(rawTag)
    const tagName = (closingMatch?.[1] ?? openingMatch?.[1] ?? '').toLowerCase()

    if (DROP_CONTENT_TAGS.has(tagName)) {
      if (!closingMatch && !stack.includes(tagName)) stack.push(tagName)
      else if (closingMatch && stack[stack.length - 1] === tagName) stack.pop()
      cursor = tagEnd + 1
      continue
    }

    if (hasDroppedContent(stack)) {
      cursor = tagEnd + 1
      continue
    }

    if (closingMatch) {
      if (ALLOWED_TAGS.has(tagName) && stack[stack.length - 1] === tagName) {
        stack.pop()
        output.push(`</${tagName}>`)
      }
      cursor = tagEnd + 1
      continue
    }

    if (openingMatch && ALLOWED_TAGS.has(tagName)) {
      const selfClosing = Boolean(openingMatch[3]) || VOID_TAGS.has(tagName)
      output.push(`<${tagName}${sanitizeAttributes(openingMatch[2])}>`)
      if (!selfClosing) stack.push(tagName)
    }

    cursor = tagEnd + 1
  }

  while (stack.length > 0) output.push(`</${stack.pop()}>`)
  return output.join('')
}

export default sanitizeHtml
