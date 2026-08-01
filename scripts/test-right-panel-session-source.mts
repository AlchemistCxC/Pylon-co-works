import assert from 'node:assert/strict'
import { resolveSessionSource } from '../src/components/chat/sessionCommandState.ts'

const sessions = [
  { id: 'local-a', source: 'backend-a' },
  { id: 'local-b', source: 'backend-b' },
]

// 统一契约（原 rightPanelTypes 版迁入）：id 匹配，未命中/空返回 null
assert.equal(resolveSessionSource(null, sessions), null)
assert.equal(resolveSessionSource('missing', sessions), null)
assert.equal(resolveSessionSource('local-a', sessions), 'backend-a')
assert.equal(resolveSessionSource('local-b', sessions), 'backend-b')

// 统一契约扩展：也按 source 匹配（原 sessionCommandState 语义），未命中返回 null（原 configOptionState 断言迁入）
assert.equal(resolveSessionSource('backend-a', sessions), 'backend-a')
assert.equal(resolveSessionSource('missing', [{ id: 'local-id', source: 'backend-source' }]), null)
assert.equal(resolveSessionSource(null, [{ id: 'local-id', source: 'backend-source' }]), null)

console.log('Session.id → Session.source（统一 resolveSessionSource）: PASS')
