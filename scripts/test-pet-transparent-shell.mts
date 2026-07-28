import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const component = readFileSync(new URL('../src/components/PetCompanion.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/PetCompanion.css', import.meta.url), 'utf8')

assert.doesNotMatch(component, /pet-heading|pet-growth|pet-actions|pet-stats|pet-collapse/,
  '默认宠物 DOM 不应保留常驻标题、成长、操作、统计或折叠控件')
assert.match(component, /className="pet-creature-hitbox"/,
  '宠物本体应有贴合点击范围的交互外壳')
assert.match(component, /onDoubleClick=\{resumeWander\}/,
  '宠物本体应保留双击恢复自主漫游')
assert.match(css, /\.pet-companion\s*\{[^}]*background\s*:\s*transparent/s,
  '宠物定位外壳必须显式透明')
assert.doesNotMatch(css, /backdrop-filter|\.pet-heading|\.pet-growth|\.pet-actions|\.pet-stats|\.pet-collapse/,
  '移除面板后必须同步删除死 CSS')

console.log('pet transparent shell tests passed')
