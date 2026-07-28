import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const backend = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
const frontend = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')

assert.match(backend, /fn should_forward_user_update\(is_replay: bool\) -> bool/,
  '后端应显式区分实时 user update 与历史 replay')
assert.match(backend, /if should_forward_user_update\(is_replay\)/,
  '只有 replay user update 才应转发到前端，实时用户消息已有本地原文事件')
assert.match(backend, /if variant == Some\("user_message_chunk"\) \{\s*if should_forward_user_update\(is_replay\)/,
  'user_message_chunk 必须先经过 replay gate，不能无条件转发')
assert.match(frontend, /invoke<SessionResponse>\('new_session', \{ source: s\.source, persona/,
  'Profile persona 仍应进入会话运行时，不因隐藏显示而失效')

console.log('profile prompt visibility tests passed')
