import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const entry = readFileSync(new URL('../scripts/run-frontend-tests.mts', import.meta.url), 'utf8')
assert.match(entry, /spawnSync\(process\.execPath, \[\.\.\.process\.execArgv, scriptPath\]/)
assert.match(entry, /exit code:/)
assert.match(entry, /process\.exitCode = failed \? 1 : 0/)
assert.match(entry, /allowedFailures = new Map/)
assert.match(entry, /baseline: allowed failure/)

const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
assert.match(chatView, /const sessions = useStore\(state => state\.sessions\)/)
assert.match(chatView, /const knownSources = new Set\(/)
assert.match(chatView, /Object\.keys\(generationStartRef\.current\)/)
assert.match(chatView, /Object\.keys\(cancelStateRef\.current\)/)
assert.match(chatView, /\}, \[sessions, sessionId\]\)/)

console.log('Chat/Replay runner and cleanup contract passed')
