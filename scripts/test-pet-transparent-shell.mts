import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { classifyPetPointerGesture, resolvePetClick } from '../src/components/petMotion.ts'

const component = readFileSync(new URL('../src/components/PetCompanion.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/PetCompanion.css', import.meta.url), 'utf8')

assert.doesNotMatch(component, /pet-heading|pet-growth|pet-actions|pet-stats|pet-collapse/,
  '默认宠物 DOM 不应保留常驻标题、成长、操作、统计或折叠控件')
assert.match(component, /className="pet-creature-hitbox"/,
  '宠物本体应有贴合点击范围的交互外壳')
assert.match(component, /import \{[^}]*classifyPetPointerGesture[^}]*resolvePetClick[^}]*\} from ['"]\.\/petMotion['"]/,
  'PetCompanion 应引入指针手势分类和点击解析纯函数')
assert.match(component, /classifyPetPointerGesture\(\{[^}]*startX:[^}]*durationMs:/s,
  'PetCompanion 应调用 classifyPetPointerGesture')
assert.match(component, /resolvePetClick\(\{[^}]*lastClickAt:[^}]*currentClickAt(?:\s*[,}])/s,
  'PetCompanion 应调用 resolvePetClick')
assert.match(component, /const onPointerUp[\s\S]*?if \(click\.kind === ['"]double['"]\)[\s\S]*?resumeWander\(\)/,
  'pointerup 双击分支应调用 resumeWander 恢复自主漫游')
assert.match(component, /insetChanged && rightInset > 0[\s\S]*?clampPetPosition\(/,
  '右栏首次打开时，未定位宠物也应立即收敛到安全区域')

assert.equal(
  classifyPetPointerGesture({ startX: 10, startY: 20, endX: 10, endY: 20, durationMs: 120 }),
  'click',
  '短距离单击应被识别为 click',
)
assert.equal(
  resolvePetClick({ lastClickAt: null, currentClickAt: 1_000 }).kind,
  'pending-single',
  '第一次单击应进入 pending-single，等待 300ms 窗口确认',
)
assert.deepEqual(
  resolvePetClick({ lastClickAt: 1_000, currentClickAt: 1_300 }),
  { kind: 'double', nextLastClickAt: null },
  '300ms 内第二次单击应解析为 double',
)
assert.equal(
  classifyPetPointerGesture({ startX: 10, startY: 20, endX: 30, endY: 20, durationMs: 120 }),
  'drag',
  '超过拖拽阈值的移动应被识别为 drag',
)
assert.notEqual(
  classifyPetPointerGesture({ startX: 10, startY: 20, endX: 30, endY: 20, durationMs: 120 }),
  'click',
  '拖拽不应误触发单击路径',
)
assert.equal(
  resolvePetClick({ lastClickAt: 1_000, currentClickAt: 1_301 }).kind,
  'pending-single',
  '超过 300ms 的第二次单击不应误判为双击',
)

assert.match(css, /\.pet-companion\s*\{[^}]*background\s*:\s*transparent/s,
  '宠物定位外壳必须显式透明')
assert.doesNotMatch(css, /backdrop-filter|\.pet-heading|\.pet-growth|\.pet-actions|\.pet-stats|\.pet-collapse/,
  '移除面板后必须同步删除死 CSS')

console.log('pet transparent shell tests passed')
