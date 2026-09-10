import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexCss = readFileSync(new URL('../../../index.css', import.meta.url), 'utf8')
const mainTsx = readFileSync(new URL('../../../main.tsx', import.meta.url), 'utf8')
const petCss = readFileSync(new URL('../../../plugins/product/packages/builtin.pylon-renderers/styles/components/PetCompanion.css', import.meta.url), 'utf8')
const builtinRendererSource = readFileSync(new URL('../../../plugins/product/builtinPylonRenderers.ts', import.meta.url), 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as {
  dependencies?: Record<string, string>
}

describe('默认代码字体 contract', () => {
  it('使用 Windows VS Code 的 Consolas → Courier New 顺序', () => {
    expect(indexCss).toMatch(/--font-mono-default:\s*'Consolas',\s*'Courier New'/)
    expect(indexCss).not.toContain('JetBrains Mono')
    expect(builtinRendererSource).toMatch(/label:\s*'Consolas（VS Code 默认）'/)
    expect(builtinRendererSource).toMatch(/family:\s*"'Consolas', 'Courier New'/)
    expect(builtinRendererSource).toMatch(/roles:\s*\['interface', 'content', 'code'\]/)
  })

  it('不再为已移除的 JetBrains 默认字体加载静态资源', () => {
    expect(mainTsx).not.toContain('@fontsource/jetbrains-mono')
    expect(packageJson.dependencies?.['@fontsource/jetbrains-mono']).toBeUndefined()
  })

  it('普通宠物面板文本跟随界面字体，状态/代码标签仍保留 mono 语义', () => {
    expect(petCss).toMatch(/\.pet-panel header strong[^\n]*font:650 13px\/1\.3 var\(--font\)/)
    expect(petCss).toMatch(/\.pet-care-controls button[^\n]*font:11px var\(--font\)/)
    expect(petCss).toMatch(/\.pet-cosmetic-list button[^\n]*font:9px var\(--font\)/)
    expect(petCss).toMatch(/\.pet-panel header span[^\n]*font:10px\/1\.3 var\(--mono\)/)
  })
})
