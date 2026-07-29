import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { clearChatSourceRefs, type ChatSourceRefCollections } from '../src/components/chat/sessionCleanup.ts'

const refs: ChatSourceRefCollections = {
  messagesBySource: { A: ['message'], B: ['keep'] },
  generationStart: { A: 1, B: 2 },
  generationFrames: { A: ['frame'], B: ['keep'] },
  loadGeneration: { A: 3, B: 4 },
  replayingSources: { A: [], B: ['keep'] },
  replayToolIds: { A: ['tool-a'], B: ['tool-b'] },
  cancelState: { A: { status: 'cancelled' }, B: { status: 'generating' } },
}

clearChatSourceRefs(refs, 'A')
for (const collection of Object.values(refs)) {
  assert.equal('A' in collection, false, '删除 Session 后不得保留旧 source 引用')
  assert.equal('B' in collection, true, '删除 A 不得影响 B')
}

clearChatSourceRefs(refs, '')
assert.equal('B' in refs.messagesBySource, true, '空 source 不得误清理其他会话')

const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
assert.match(chatView, /clearChatSourceRefs\(/, 'ChatView 必须调用统一 source ref 清理 helper')
assert.match(chatView, /const activeSources = new Set\(sessions\.map\(session => session\.source\)\)/, '清理必须以当前 sessions source 集合为准')
assert.match(chatView, /messagesBySourceRef\.current/, '清理必须覆盖消息缓存')
assert.match(chatView, /generationStartRef\.current/, '清理必须覆盖 generation start')
assert.match(chatView, /generationFramesRef\.current/, '清理必须覆盖 generation frames')
assert.match(chatView, /loadGenerationRef\.current/, '清理必须覆盖 load generation')
assert.match(chatView, /replayingSourcesRef\.current/, '清理必须覆盖 replay buffer')
assert.match(chatView, /replayToolIdsRef\.current/, '清理必须覆盖 replay tool IDs')
assert.match(chatView, /cancelStateRef\.current/, '清理必须覆盖 cancel state')

console.log('session cleanup regression tests passed')
