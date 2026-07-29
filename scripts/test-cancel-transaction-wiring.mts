import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const inputBar = readFileSync(new URL('../src/components/chat/InputBar.tsx', import.meta.url), 'utf8')
const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
const cancelState = readFileSync(new URL('../src/components/chat/cancelState.ts', import.meta.url), 'utf8')

assert.match(inputBar, /from '\.\/cancelState'/, 'InputBar 必须接入取消状态模块')
assert.match(inputBar, /const begun = beginCancel\(sessionSource, cancelStateRef\.current\)/, 'InputBar 必须先进入 canceling 并去重')
assert.match(inputBar, /await invoke\('cancel_prompt', \{ source: sessionSource \}\)/, 'InputBar 必须使用解析后的 Session.source')
assert.match(inputBar, /resolveCancelCommand\(sessionSource, cancelStateRef\.current\)/, 'command resolve 必须只收敛请求状态')
assert.match(inputBar, /rejectCancelCommand\(sessionSource, cancelStateRef\.current, error\)/, 'command reject 必须恢复当前 source 状态')
assert.match(inputBar, /cancel\(\)/, '键盘和按钮必须复用 cancel 入口')

assert.match(chatView, /from '\.\/cancelState'/, 'ChatView 必须接入取消状态模块')
assert.match(chatView, /const begun = beginCancel\(source, currentCancelState\)/, 'Footer 停止入口必须使用取消状态机')
assert.match(chatView, /resolveCancelCommand\(source, cancelStateRef\.current\[source\]/, 'ChatView 不得把 command resolve 当作完成事件')
assert.match(chatView, /event\.payload\.cancelled === true/, 'ChatView 必须识别 cancelled 终止事件')
assert.match(chatView, /applyCancelEvent\(/, 'ChatView 必须由事件收敛取消状态')
assert.doesNotMatch(chatView, /invoke\('cancel_prompt',[\s\S]{0,500}setSummary\([\s\S]{0,200}reason: 'cancelled'/, 'cancel_prompt resolve 不得直接伪造 cancelled summary')

assert.match(cancelState, /status: 'canceling'/, '纯状态必须包含 canceling')
assert.match(cancelState, /status: 'cancelled'/, '纯状态必须包含 cancelled')

console.log('cancel transaction wiring regression tests passed')
