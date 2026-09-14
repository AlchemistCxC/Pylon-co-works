import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexCss = readFileSync(new URL('../../../index.css', import.meta.url), 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as {
  dependencies?: Record<string, string>
}

describe('默认代码字体 contract', () => {
  it('使用 Windows VS Code 的 Consolas → Courier New 字体栈（host 样式单一真值表）', () => {
    expect(indexCss).toMatch(/--font-mono-default:\s*'Consolas',\s*'Courier New'/)
    expect(indexCss).not.toContain('JetBrains Mono')
  })

  it('不再为已移除的 JetBrains 默认字体声明运行时依赖（依赖缺席）', () => {
    expect(packageJson.dependencies?.['@fontsource/jetbrains-mono']).toBeUndefined()
  })
})
