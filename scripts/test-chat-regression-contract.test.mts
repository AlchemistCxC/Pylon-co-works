/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'

test('chat replay regression contract（legacy 迁移）', async () => {

const root = new URL('../src/components/chat/', import.meta.url)
const controller = readFileSync(new URL('chatEventController.ts', root), 'utf8')
const store = readFileSync(new URL('sessionRuntimeStore.ts', root), 'utf8')
const replayState = readFileSync(new URL('replayState.ts', root), 'utf8')
const persistence = readFileSync(new URL('messagePersistence.ts', root), 'utf8')
const eventState = readFileSync(new URL('sessionEventState.ts', root), 'utf8')
const projectionRules = readFileSync(new URL('../src/domains/events/messageProjectionRules.ts', import.meta.url), 'utf8')

// CV-4：事件控制器挂接收敛到 useSessionLifecycle（attach 必须先于切换 effect）
const lifecycleHook = readFileSync(new URL('useSessionLifecycle.ts', root), 'utf8')
assert.match(lifecycleHook, /attachChatEventController\(controllerRefs\)/, 'hook 必须挂载事件控制器')
assert.ok(lifecycleHook.indexOf('attachChatEventController(controllerRefs)') < lifecycleHook.indexOf('if (sessionId === prevSessionRef.current && processedReloadRef.current === reloadToken) return'), 'controller attach 必须先于 session 切换 effect 声明')
assert.doesNotMatch(store, /replaying/, 'U2-C 单一路径不得保留 replaying 缓冲')
assert.match(store, /event\.replay === true \|\| event\.explicitReplay === true/, 'done/error 作用域必须由事件标志承载')
assert.match(store, /terminationScope/, 'reducer 必须区分 replay/live 终止事件')
assert.match(projectionRules, /export function settleMessages/, '共享 projection rule 必须提供终态收敛')
assert.match(projectionRules, /message\.role === 'tool' && message\.running/, '共享规则必须收敛 running Tool')
assert.match(projectionRules, /toolStatus:\s*message\.toolStatus\s*\|\|\s*'completed'/, 'running Tool 必须补 completed 终态')
assert.match(store, /settleMessages as settleProjectedMessages/, 'runtime 必须接入共享终态规则')
assert.match(store, /settleProjectedMessages\(runtime\.messages\)/, 'runtime settle 必须消费共享 projection rule')
assert.match(store, /normalizeToolId/, 'Tool 事件必须归一化 ID')
assert.match(store, /shouldAcceptToolCall/, 'Tool replay 必须防重复/乱序污染')
assert.match(controller, /knownSources\(\)\.includes\(source\)/, '事件必须按已存在 source 路由')
assert.doesNotMatch(controller, /messagePersistScheduler/, 'A1-c 后不得再写 messages 表')
assert.match(controller, /persistCanonicalEvent\(/, 'live 会话事件必须走 canonical 持久化入口')
assert.match(controller, /canonicalSink\.offer/, 'canonical 写入必须经 sink 归一/落盘')
assert.match(controller, /clearMessageStorage/, 'clear 必须清理消息缓存')
assert.match(store, /cancelState: CancelState/, 'cancel 状态必须按 source 保存')
assert.match(replayState, /export function normalizeToolId/, 'Tool ID helper 必须存在')
assert.match(replayState, /export function shouldAcceptToolCall/, 'replay 工具去重 helper 必须存在')
assert.match(replayState, /export function nextLoadGeneration/, 'load generation helper 必须存在')
assert.match(persistence, /ownerId/, '持久化必须保留 owner guard')
assert.match(persistence, /renderedSource/, '持久化必须校验 rendered source')
assert.match(eventState, /addGeneratingSource/, 'generating 必须按 source 集合添加')
assert.match(eventState, /removeGeneratingSource/, 'generating 必须按 source 集合移除')

console.log('chat replay regression contract passed')

})
