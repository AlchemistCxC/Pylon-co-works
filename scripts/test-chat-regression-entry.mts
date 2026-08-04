import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const entry = readFileSync(new URL('../scripts/run-frontend-tests.mts', import.meta.url), 'utf8')
assert.match(entry, /spawnSync\(process\.execPath, \[\.\.\.process\.execArgv, scriptPath\]/)
assert.match(entry, /exit code:/)
assert.match(entry, /process\.exitCode = failed \? 1 : 0/)
assert.match(entry, /allowedFailures = new Map/)
assert.match(entry, /baseline: allowed failure/)

const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
const lifecycleHook = readFileSync(new URL('../src/components/chat/useSessionLifecycle.ts', import.meta.url), 'utf8')
assert.match(chatView, /const sessions = useIdentityStore\(state => state\.sessions\)/)
// CV-4：会话清理/异步守卫收敛到 useSessionLifecycle
assert.match(lifecycleHook, /pruneSources\(activeSources\)/, '会话清理必须走 controller.pruneSources')
assert.match(lifecycleHook, /loadGenerationRef\.current/, '异步守卫必须按 source 清理')
assert.match(lifecycleHook, /\}, \[sessions, sessionId\]\)/)

console.log('Chat/Replay runner and cleanup contract passed')
