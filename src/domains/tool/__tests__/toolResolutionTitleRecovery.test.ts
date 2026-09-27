import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearToolRegistryForTests } from '../toolRegistry.ts'
import { registerToolDictionary } from '../toolRegistry.ts'
import { resolveToolType } from '../toolResolution.ts'

beforeEach(() => clearToolRegistryForTests())
afterEach(() => clearToolRegistryForTests())

/** #315：hermes polished title → machine name 反解。
 *  wire 只带 title（长尾工具恰为裸 machine name，常用工具为「前缀: 参数」格式，
 *  见 hermes acp_adapter/tools.py::build_tool_title），字典 alias 补齐后前端即可
 *  恢复 machine 语义，wire 零改动。 */
describe('hermes title 反解（#315）', () => {
  beforeEach(() => {
    registerToolDictionary({
      hermes: [
        { name: 'read_file', aliases: ['read'], kind: 'read', action: 'read', summary_fields: ['path'] },
        { name: 'execute_code', aliases: ['python'], kind: 'execute', action: 'execute', summary_fields: ['code'] },
        { name: 'web_search', aliases: ['web search'], kind: 'fetch', action: 'fetch' },
        { name: 'browser_navigate', aliases: ['navigate'], kind: 'fetch', action: 'navigate' },
        { name: 'browser_snapshot', aliases: ['browser snapshot'], kind: 'read', action: 'read' },
        { name: 'image_generate', aliases: ['generate image'], kind: 'execute', action: 'execute' },
      ],
    })
  })

  it('未登记的裸 machine name 维持既有 alias/fallback 兜底', () => {
    const click = resolveToolType('browser_click', undefined, { provider: 'hermes' })
    expect(click.matchedBy).toBe('alias-dictionary')
    const kanban = resolveToolType('kanban_show', undefined, { provider: 'hermes' })
    expect(kanban.matchedBy).toBe('fallback')
  })

  it('「前缀: 参数」title 反解出 machine name 与内嵌摘要', () => {
    const read = resolveToolType('read: /tmp/a.txt', undefined, { provider: 'hermes' })
    expect(read).toMatchObject({ matchedBy: 'provider-dictionary', canonicalName: 'read_file', kind: 'read', embeddedSummary: '/tmp/a.txt' })

    const python = resolveToolType('python: x = 1', undefined, { provider: 'hermes' })
    expect(python).toMatchObject({ matchedBy: 'provider-dictionary', canonicalName: 'execute_code', embeddedSummary: 'x = 1' })

    const webSearch = resolveToolType('web search: pylon acp', undefined, { provider: 'hermes' })
    expect(webSearch).toMatchObject({ matchedBy: 'provider-dictionary', canonicalName: 'web_search', embeddedSummary: 'pylon acp' })

    const navigate = resolveToolType('navigate: https://example.com', undefined, { provider: 'hermes' })
    expect(navigate).toMatchObject({ matchedBy: 'provider-dictionary', canonicalName: 'browser_navigate' })
  })

  it('无参全等 title（browser snapshot / generate image）经全等臂命中', () => {
    const snapshot = resolveToolType('browser snapshot', undefined, { provider: 'hermes' })
    expect(snapshot).toMatchObject({ matchedBy: 'provider-dictionary', canonicalName: 'browser_snapshot', kind: 'read' })
    expect(snapshot.embeddedSummary).toBeUndefined()

    const generate = resolveToolType('generate image: sunset', undefined, { provider: 'hermes' })
    expect(generate).toMatchObject({ matchedBy: 'provider-dictionary', canonicalName: 'image_generate', embeddedSummary: 'sunset' })
  })

  it('wire kind 存在时仍为权威（title 反解只补 name/canonical 语义）', () => {
    const resolution = resolveToolType('read: /tmp/a.txt', 'read', { provider: 'hermes' })
    expect(resolution.matchedBy).toBe('wire')
    expect(resolution.canonicalName).toBe('read_file')
  })
})
