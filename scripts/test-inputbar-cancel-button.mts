import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const inputBar = readFileSync(new URL('../src/components/chat/InputBar.tsx', import.meta.url), 'utf8')
const inputCss = readFileSync(new URL('../src/components/chat/InputBar.css', import.meta.url), 'utf8')

assert.match(inputBar, /const generating = useRuntimeStore\(s => sessionSource != null && \(s\.liveGeneratingSources \|\| \[\]\)\.includes\(sessionSource\)\)/, '生成态必须按当前 Session.source 读取')
assert.match(inputBar, /const cancel = async \(\) =>/, '必须存在统一 cancel 入口')
assert.match(inputBar, /if \(!sessionId \|\| !sessionSource\) return/, '取消前必须拒绝缺失 source')
assert.match(inputBar, /getChatController\(\)\?\.requestCancel\(sessionSource\)/, '取消必须走 controller 统一入口（使用解析后的 Session.source）')
assert.match(inputBar, /className=\{`input-btn \$\{generating \? 'stop' : 'send'\}`\}/, '发送按钮必须按 generating 切换 stop/send 样式')
assert.match(inputBar, /onClick=\{generating \? cancel : send\}/, '生成态按钮必须复用 cancel，空闲态仍发送')
assert.match(inputBar, /generating \? <Square size=\{16\} \/> : <ArrowUp size=\{18\} \/>/, '按钮图标必须按生成态切换')
assert.match(inputBar, /aria-label=\{generating \? '停止生成' : '发送'\}/, '按钮必须有稳定可访问名称')
assert.match(inputCss, /\.input-btn\.stop\s*\{[^}]*color:var\(--danger/, '停止态必须有明确视觉样式')

console.log('InputBar 生成中停止按钮回归测试通过')
