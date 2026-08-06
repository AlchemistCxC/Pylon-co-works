import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

// W2-10：侧栏平铺（F2-C，行为敏感）——删平台分组、按 lastActiveAt、运行点读 liveGeneratingSources

const sidebar = readFileSync(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/Sidebar.css', import.meta.url), 'utf8')

// 1. 删除平台分组
assert.equal(sidebar.includes('PLATFORM_LABELS'), false, '不得再有平台标签分组')
assert.equal(sidebar.includes('details'), false, '不得再有分组 details')
assert.equal(sidebar.includes('.group-header'), false, '组件内不得再引用分组头')

// 2. 平铺 + 按 lastActiveAt 倒序
assert.match(sidebar, /\.sort\(\(a, b\) => \(b\.lastActiveAt \|\| 0\) - \(a\.lastActiveAt \|\| 0\)\)/, '必须按 lastActiveAt 倒序')
assert.match(sidebar, /\.filter\(s => s\.profileId === activeProfileId\)/, '必须按当前 profile 过滤')

// 3. 运行点：读 liveGeneratingSources（periId 存在不再等于 running）
assert.match(sidebar, /liveGeneratingSources = useRuntimeStore\(s => s\.liveGeneratingSources \|\| \[\]\)/, '必须读 liveGeneratingSources')
assert.match(sidebar, /data-running=\{liveGeneratingSources\.includes\(s\.source\) \? 'true' : undefined\}/, '运行点必须按 source 的 liveGeneratingSources')
assert.equal(sidebar.includes('s.periId ?'), false, 'periId 存在不得再着色运行点')

// 4. 保留搜索/重命名/删除/设置交互
assert.match(sidebar, /search\.toLowerCase\(\)/, '搜索保留')
assert.match(sidebar, /setRenaming\(s\.id\)/, '重命名保留')
assert.match(sidebar, /handleDelete\(s\.id\)/, '删除保留')
assert.match(sidebar, /onSessionSettings\(s\.id\)/, '设置保留')

// 5. CSS：运行点色 + 死分组样式清理
assert.match(css, /\.session-dot\[data-running="true"\]/, '运行点必须读 data-running 着色')
assert.equal(css.includes('.group-header'), false, '死分组样式必须清理')

console.log('agent sidebar 平铺守卫通过')
