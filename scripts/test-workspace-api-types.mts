import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type {
  WorkspaceApiAdapter,
  WorkspaceApiScope,
  WorkspaceListRequest,
  WorkspaceReadRequest,
  WorkspaceRootRequest,
} from '../src/components/right-panel/workspaceApi.ts'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(join(projectRoot, 'src/components/right-panel/workspaceApi.ts'), 'utf8')

assert.match(source, /interface WorkspaceApiAdapter/)
assert.match(source, /interface WorkspaceApiScope/)
assert.match(source, /root\(/)
assert.match(source, /list\(/)
assert.match(source, /read\(/)
assert.match(source, /Promise<TRoot>/)
assert.match(source, /Promise<TList>/)
assert.match(source, /Promise<TRead>/)
assert.doesNotMatch(source, /invoke\s*\(/)
assert.doesNotMatch(source, /fetch\s*\(/)

const seen: string[] = []
const adapter: WorkspaceApiAdapter<string, readonly string[], { content: string }> = {
  async root(request: WorkspaceRootRequest) {
    seen.push(`root:${request.scope.source}`)
    return 'root-result'
  },
  async list(request: WorkspaceListRequest) {
    seen.push(`list:${request.scope.source}:${request.path ?? ''}`)
    return ['entry']
  },
  async read(request: WorkspaceReadRequest) {
    seen.push(`read:${request.scope.source}:${request.path}`)
    return { content: 'read-result' }
  },
}

const scope: WorkspaceApiScope = { source: 'backend-source-1' }
assert.equal(await adapter.root({ scope }), 'root-result')
assert.deepEqual(await adapter.list({ scope, path: 'src' }), ['entry'])
assert.deepEqual(await adapter.read({ scope, path: 'src/main.ts' }), { content: 'read-result' })
assert.deepEqual(seen, [
  'root:backend-source-1',
  'list:backend-source-1:src',
  'read:backend-source-1:src/main.ts',
])

console.log('workspace API adapter 类型边界回归测试通过')
