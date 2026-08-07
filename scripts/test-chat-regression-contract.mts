/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const root = new URL('../src/components/chat/', import.meta.url)
const chatView = readFileSync(new URL('ChatView.tsx', root), 'utf8')
const controller = readFileSync(new URL('chatEventController.ts', root), 'utf8')
const store = readFileSync(new URL('sessionRuntimeStore.ts', root), 'utf8')
const replayState = readFileSync(new URL('replayState.ts', root), 'utf8')
const persistence = readFileSync(new URL('messagePersistence.ts', root), 'utf8')
const eventState = readFileSync(new URL('sessionEventState.ts', root), 'utf8')

// CV-4：事件控制器挂接收敛到 useSessionLifecycle（attach 必须先于切换 effect）
const lifecycleHook = readFileSync(new URL('useSessionLifecycle.ts', root), 'utf8')
assert.match(chatView, /useSessionLifecycle\(/, 'ChatView 必须消费会话生命周期 hook')
assert.match(lifecycleHook, /attachChatEventController\(controllerRefs\)/, 'hook 必须挂载事件控制器')
assert.ok(lifecycleHook.indexOf('attachChatEventController(controllerRefs)') < lifecycleHook.indexOf('if (sessionId === prevSessionRef.current) return'), 'controller attach 必须先于 session 切换 effect 声明')
assert.match(store, /resolveReplayEventMode/, 'reducer 必须使用 replay/live 事件归一化')
assert.match(store, /terminationScope/, 'reducer 必须区分 replay/live 终止事件')
assert.match(store, /message\.role === 'tool' && message\.running/, '历史 Tool 必须有稳定终态收敛')
assert.match(store, /normalizeToolId/, 'Tool 事件必须归一化 ID')
assert.match(store, /shouldAcceptToolCall/, 'Tool replay 必须防重复/乱序污染')
assert.match(controller, /knownSources\(\)\.includes\(source\)/, '事件必须按已存在 source 路由')
assert.match(controller, /persistMessageSnapshot/, '后台与当前消息必须走统一持久化入口')
assert.match(controller, /clearMessageStorage/, 'clear 必须清理消息缓存')
assert.match(store, /cancelState: CancelState/, 'cancel 状态必须按 source 保存')
assert.match(replayState, /export function resolveReplayEventMode/, 'replay 状态 helper 必须存在')
assert.match(replayState, /export function resolveTerminationScope/, '终止 scope helper 必须存在')
assert.match(replayState, /export function normalizeToolId/, 'Tool ID helper 必须存在')
assert.match(persistence, /ownerId/, '持久化必须保留 owner guard')
assert.match(persistence, /renderedSource/, '持久化必须校验 rendered source')
assert.match(eventState, /addGeneratingSource/, 'generating 必须按 source 集合添加')
assert.match(eventState, /removeGeneratingSource/, 'generating 必须按 source 集合移除')

console.log('chat replay regression contract passed')
