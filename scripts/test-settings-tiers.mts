/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolveBasicThemeFields } from '../src/themeFieldDefs.ts'

// W2-13（F3-A）：设置三层——basic 清单来自 defs（组件不硬编码）；进阶内容原样；宠物控制读 workspaceStore

// 1. basic 清单来自 defs 单一真值
{
  const basic = resolveBasicThemeFields()
  assert.ok(basic.length >= 12, `basic 字段应 ≥12（实际 ${basic.length}）`)
  assert.ok(basic.includes('accent'), 'accent 应在 basic')
  assert.ok(basic.includes('globalFontSize'))
  assert.ok(basic.includes('uiScheme'))
  assert.ok(basic.includes('chatTextColor'))
  assert.ok(basic.includes('inputFontSize'))
  assert.ok(basic.includes('spinnerColor'))
}

// 2. Settings 接线：tier 导航 + 快速层经 defs 渲染（无硬编码字段名）+ 宠物读 workspaceStore
const settings = readFileSync(new URL('../src/components/Settings.tsx', import.meta.url), 'utf8')
assert.match(settings, /TIERS = \['quick', 'advanced', 'expert'\]/, '必须有三层定义')
assert.match(settings, /TIER_LABELS/, '必须有三层标签')
assert.match(settings, /settings-quick/, '必须有快速层视图')
assert.match(settings, /basicOnly/, '快速层必须经 ZoneGroupFields basicOnly 渲染（不硬编码字段名）')
assert.equal(settings.includes("'accent', 'globalFontSize'"), false, '不得在组件硬编码 basic 字段清单')
assert.match(settings, /useWorkspaceStore\(s => s\.showPet\)/, '快速层宠物控制必须读 workspaceStore')

// 3. 进阶内容原样：tier !== quick 渲染现状 tabs-root
assert.match(settings, /tier !== 'quick' && \(/, '进阶/专家渲染现状 tabs')
assert.match(settings, /settings-tabs-root/, '现状 tabs 保留')

// 4. ZoneGroupFields basicOnly 过滤（defs 派生）
const renderer = readFileSync(new URL('../src/themeFieldRenderer.tsx', import.meta.url), 'utf8')
assert.match(renderer, /basicOnly\?: boolean/, 'ZoneGroupFields 必须支持 basicOnly')
assert.match(renderer, /!basicOnly \|\| def\.tier === 'basic'/, 'basicOnly 必须过滤 tier:basic')

console.log('settings tiers 守卫通过')
