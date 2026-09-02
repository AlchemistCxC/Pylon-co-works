/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolveBasicThemeFields } from '../src/themeFieldDefs.ts'

// I13-W2：设置域由标题栏菜单驱动，Settings 只渲染当前 domain 的 section。
// basic 清单仍来自 defs（组件不硬编码）；quick/advanced/expert 不再是一级信息架构；
// 宠物控制读 workspaceStore。

// 1. basic 清单来自 defs 单一真值（defs 不变，tier 元数据保留供后续域内 disclosure 使用）
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

// 2. Settings 接线：一级域切换由标题栏菜单承担；Settings 仅消费当前 domain
// 与其 section，tier/快速层退役。
const settings = readFileSync(new URL('../src/components/Settings.tsx', import.meta.url), 'utf8')
assert.match(settings, /activeDomainConfig\.sections\.map/, 'section 导航必须由 domain config 驱动')
assert.doesNotMatch(settings, /settings-domain-rail/, 'Settings 不得保留一级域导航 rail')
assert.doesNotMatch(settings, /TIERS\s*=\s*\[/, 'tier 导航定义必须退役')
assert.doesNotMatch(settings, /TIER_LABELS/, 'tier 标签必须退役')
assert.doesNotMatch(settings, /settings-quick/, '快速层视图必须退役')
assert.doesNotMatch(settings, /basicOnly/, '快速层渲染路径必须退役')
assert.equal(settings.includes("'accent', 'globalFontSize'"), false, '不得在组件硬编码 basic 字段清单')
assert.match(settings, /useWorkspaceStore\(s => s\.showPet\)/, '宠物控制必须读 workspaceStore')

// 3. domain config 为导航唯一真值：Settings 不得再自持 tab/tier 表
const domains = readFileSync(new URL('../src/settingsDomains.ts', import.meta.url), 'utf8')
assert.match(domains, /SETTINGS_DOMAINS/, '必须定义 domain config')
assert.match(domains, /'appearance'[\s\S]*'workspace'[\s\S]*'agents-connections'/, '必须定义外观/工作区/Agent 与连接三域')
assert.match(domains, /SECTION_ZONES/, '必须定义 section→zone 字段归属')
assert.doesNotMatch(settings, /const TABS\s*=/, 'Settings 不得再自持 tab 表')
assert.doesNotMatch(settings, /const TAB_LABELS/, 'Settings 不得再自持 tab 标签')
assert.match(settings, /settings-tabs-root/, '现状两栏布局保留')

// 标题栏是四个顶级设置域的唯一切换入口，并把 canonical intent 交给 App/Settings。
const titlebar = readFileSync(new URL('../src/workspace-sheets/WorkspaceTitlebar.tsx', import.meta.url), 'utf8')
assert.match(titlebar, /SETTINGS_DOMAINS\.map/, '标题栏设置菜单必须由 SETTINGS_DOMAINS 驱动')
assert.match(titlebar, /onOpenSettingsDomain/, '标题栏必须提供设置域切换回调')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
assert.match(app, /onOpenSettingsDomain=\{/, 'App 必须接线标题栏设置域回调')
assert.match(app, /pylon:open-settings/, '域切换必须复用现有 Settings intent 事件')

// 4. ZoneGroupFields 不再保留已退役的快速层过滤入口
const renderer = readFileSync(new URL('../src/themeFieldRenderer.tsx', import.meta.url), 'utf8')
assert.doesNotMatch(renderer, /basicOnly/, 'ZoneGroupFields 不得保留 basicOnly 第二条渲染路径')

console.log('settings domains 守卫通过')
