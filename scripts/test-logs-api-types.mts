import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  LogsApiAdapter,
  LogsApiScope,
  LogsClearRequest,
  LogsListRequest,
} from '../src/components/right-panel/logsApi.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const apiPath = resolve(root, 'src/components/right-panel/logsApi.ts')
const source = await readFile(apiPath, 'utf8')

assert.match(source, /export interface LogsApiScope/)
assert.match(source, /sessionId: string/)
assert.match(source, /source: string/)
assert.match(source, /export interface LogsApiAdapter/)
assert.match(source, /list\(request: LogsListRequest\)/)
assert.match(source, /clear\(request: LogsClearRequest\)/)
assert.match(source, /TList = unknown/)
assert.match(source, /TClear = unknown/)
assert.doesNotMatch(source, /\b(invoke|fetch)\s*\(/)
assert.doesNotMatch(source, /command\s*:/)

const first: LogsApiScope = { sessionId: 'session-1', source: 'agent' }
const second: LogsApiScope = { sessionId: 'session-2', source: 'agent' }
const calls: Array<{ operation: 'list' | 'clear'; scope: LogsApiScope }> = []

const adapter: LogsApiAdapter<string[], { cleared: boolean }> = {
  async list(request) {
    calls.push({ operation: 'list', scope: request.scope })
    return []
  },
  async clear(request) {
    calls.push({ operation: 'clear', scope: request.scope })
    return { cleared: true }
  },
}

const listRequest: LogsListRequest = { scope: first }
const clearRequest: LogsClearRequest = { scope: second }
assert.deepEqual(await adapter.list(listRequest), [])
assert.deepEqual(await adapter.clear(clearRequest), { cleared: true })
assert.deepEqual(calls, [
  { operation: 'list', scope: first },
  { operation: 'clear', scope: second },
])
assert.notStrictEqual(calls[0].scope.sessionId, calls[1].scope.sessionId)

console.log('Logs API adapter type boundary: PASS')
