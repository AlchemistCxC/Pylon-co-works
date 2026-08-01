import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const inputBar = readFileSync(new URL('../src/components/chat/InputBar.tsx', import.meta.url), 'utf8')
const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
const controller = readFileSync(new URL('../src/components/chat/chatEventController.ts', import.meta.url), 'utf8')
const cancelState = readFileSync(new URL('../src/components/chat/cancelState.ts', import.meta.url), 'utf8')

assert.match(inputBar, /getChatController\(\)\?\.requestCancel\(sessionSource\)/, 'InputBar 取消必须走 controller 统一入口（去重由 reducer begin-cancel 承担）')
assert.doesNotMatch(inputBar, /cancelStateRef|beginCancel|rejectCancelCommand/, 'InputBar 不再持有本地 cancelState（阶段 6.1 已并入 reducer）')
assert.match(inputBar, /cancel\(\)/, '键盘和按钮必须复用 cancel 入口')

assert.match(chatView, /requestCancel\(sessionRef\.current\)/, 'Footer 停止入口必须走 controller.requestCancel')
assert.match(chatView, /controllerHandleRef\.current\?\.requestCancel/, 'ChatView 必须通过 controller handle 取消')

assert.match(controller, /requestCancel = \(source: string\) => \{/, 'controller 必须提供 requestCancel')
assert.match(controller, /dispatch\(\{ type: 'begin-cancel', source \}\)/, '取消必须先进入 canceling 状态')
assert.match(controller, /invoke\('cancel_prompt', \{ source \}\)/, 'controller 必须调用后端取消命令')
assert.match(controller, /dispatch\(\{ type: 'cancel-success', source \}\)/, '命令 resolve 必须收敛为 cancel-success')
assert.match(controller, /dispatch\(\{ type: 'cancel-rejected', source, error/, '命令 reject 必须收敛为 cancel-rejected')
assert.match(controller, /event\.payload\.cancelled === true/, '事件控制器必须识别 cancelled 终止事件')
assert.doesNotMatch(chatView, /invoke\('cancel_prompt',[\s\S]{0,500}setSummary\([\s\S]{0,200}reason: 'cancelled'/, 'cancel_prompt resolve 不得直接伪造 cancelled summary')

assert.match(cancelState, /status: 'canceling'/, '纯状态必须包含 canceling')
assert.match(cancelState, /status: 'cancelled'/, '纯状态必须包含 cancelled')

console.log('cancel transaction wiring regression tests passed')
