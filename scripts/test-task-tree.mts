/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

// P1-06：TaskTree DOM/逻辑守卫——ChatView 挂载顺序、三态字形、跨区桥、会话切换重置、turn 间持续

const tree = readFileSync(new URL('../src/components/chat/TaskTree.tsx', import.meta.url), 'utf8')
const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')

// 1. ChatView 挂载顺序：GenerationFooter 之后、bottomRef 之前（DOM 顺序 footer→tree→bottomRef）
const footerIdx = chatView.indexOf('GenerationFooter running=')
const treeIdx = chatView.indexOf('<TaskTree source={sessionRef.current} />')
const bottomIdx = chatView.indexOf('<div ref={bottomRef} />')
assert.ok(footerIdx >= 0 && treeIdx >= 0 && bottomIdx >= 0, 'TaskTree 必须已挂载')
assert.ok(footerIdx < treeIdx, 'TaskTree 必须在 GenerationFooter 之后')
assert.ok(treeIdx < bottomIdx, 'TaskTree 必须在 bottomRef 之前')

// 2. 数据源：横向订阅（P1-05），非 ChatView 消息 setState 链
assert.match(tree, /useChatRuntimeSnapshot\(source\)/, '必须经横向订阅读 planEntries')

// 3. 无任务/无 source 返回 null（clear 清空 planEntries 后自然消失）
assert.match(tree, /tasks\.length === 0\) return null/, '无任务必须返回 null')
assert.match(tree, /!source \|\|/, '无 source 必须返回 null')

// 4. 折叠态摘要 + 展开态三态列表
assert.match(tree, /taskSummary\(tasks\)/, '折叠态必须显示摘要文案（供折叠态使用）')
assert.match(tree, /data-status=\{task\.status\}/, '任务项必须带 data-status 三态')
assert.match(tree, /case 'in_progress': return '◐'/, 'in_progress 字形')
assert.match(tree, /case 'completed': return '✓'/, 'completed 字形')
assert.match(tree, /case 'failed':\n\s+case 'cancelled': return '✕'/, 'failed/cancelled 字形')

// 5. 跨区桥：tasks widget（P1-07 登记）dispatch pylon:tasks-toggle
assert.match(tree, /window\.addEventListener\('pylon:tasks-toggle'/, '必须监听 tasks widget 的跨区桥事件')
assert.match(tree, /aria-expanded=\{expanded\}/, '折叠态按钮必须有 aria-expanded')

// 6. 会话切换重置展开态（D24 不持久化）
assert.match(tree, /setExpanded\(false\)/, '会话切换必须重置展开态')

// 7. turn 间持续：TaskTree 不依赖 generating（done 不清 plan，reducer 语义由 runtime-store 测试锁定）
assert.equal(tree.includes('generating'), false, 'TaskTree 不得依赖 generating（turn 间持续）')
assert.equal(tree.includes('pylon:done'), false, 'TaskTree 不得自行监听 done')

console.log('task tree 守卫通过')
