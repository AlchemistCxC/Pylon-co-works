import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// 下沉自 scripts/test-pet-transparent-shell.mts（P91 A2）：透明定位外壳契约。

const css = readFileSync(
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/PetCompanion.css',
  'utf8',
)

describe('PetCompanion 透明壳 CSS 契约', () => {
  it('宠物定位外壳显式透明', () => {
    expect(css).toMatch(/\.pet-companion\s*\{[^}]*background\s*:\s*transparent/s)
  })

  it('透明壳不得引入模糊；已移除结构不得残留死 CSS', () => {
    expect(css).not.toMatch(/backdrop-filter/)
    expect(css).not.toMatch(/\.pet-heading|\.pet-growth|\.pet-stats|\.pet-collapse/)
  })
})
