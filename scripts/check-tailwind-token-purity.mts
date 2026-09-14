// check-tailwind-token-purity — TW 施工书 20260914（P85）TW-2。
//
// tailwind.css 是第一方 utility 的唯一 @theme 映射入口；其值只允许 var(…)
// 引用既有 token。任何字面量色值都会形成「第二 token 源」——主题字段改了
// utility 元素不跟随。本门禁机器化这条红线（评审报告 §4.3 第 7 步）。
//
// 已知限制（评审把关兜底）：CSS 命名色字面量（white/red 等）不在扫描范围。
// 注：扫描含注释——注释里的字面量同样会误导后来者复制粘贴。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const target = fileURLToPath(new URL('../src/styles/tailwind.css', import.meta.url))
const text = readFileSync(target, 'utf8')

const patterns: ReadonlyArray<readonly [string, RegExp]> = [
  ['hex 颜色字面量', /#[0-9a-fA-F]{3,8}\b/],
  ['rgb/rgba 字面量', /\brgba?\(/],
  ['hsl/hsla 字面量', /\bhsla?\(/],
  ['oklch/oklab 字面量', /\boklch\(|\boklab\(/],
  ['color-mix 字面量（组合 token 应定义在 index.css）', /\bcolor-mix\(/],
]

const failures: string[] = []
const lines = text.split(/\r?\n/)
lines.forEach((line, index) => {
  for (const [label, pattern] of patterns) {
    if (pattern.test(line)) failures.push(`  tailwind.css:${index + 1}  ${label}：${line.trim().slice(0, 120)}`)
  }
})

if (failures.length > 0) {
  console.error(`tailwind token 纯度门禁失败：tailwind.css 只允许 var(…) 引用既有 token\n${failures.join('\n')}`)
  process.exit(1)
}
console.log(`tailwind token 纯度门禁通过（${lines.length} 行，无字面量色值）`)
