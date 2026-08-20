import { strict as assert } from 'node:assert'
import { normalizeGitStatus, normalizeGitHistory, classifyGitError } from '../src/infrastructure/tauri/gitContracts.ts'

// W2-02：Git DTO 宽容 normalize——损坏/非 git 三类不崩，porcelain 码原样保留

// 1. git_status：porcelain 码原样、staged 标记、缺 path 丢弃
{
  const status = normalizeGitStatus([
    { path: 'src/main.ts', status: ' M', staged: false },
    { path: 'src/new.ts', status: 'A', staged: true },
    { path: 'src/untracked.ts', status: '??', staged: false },
    { path: '' },
    { path: 'no-status' },
    null,
    42,
  ])
  assert.equal(status.length, 4)
  assert.deepEqual(status[0], { path: 'src/main.ts', status: ' M', staged: false })
  assert.equal(status[1]?.status, 'A')
  assert.equal(status[1]?.staged, true)
  assert.equal(status[2]?.status, '??')
  assert.equal(status[3]?.path, 'no-status')
  assert.equal(status[3]?.status, '??', '缺 status 时默认 ??')
  assert.deepEqual(normalizeGitStatus('not-array'), [])
}

// 2. git_history：hash/author/date/subject；date Unix 秒；缺 hash 丢弃
{
  const history = normalizeGitHistory([
    { hash: 'abc123', author: 'user', date: 1722500000, subject: 'fix: x' },
    { hash: 'def456', subject: 'no-author-date' },
    { hash: '' },
    null,
  ])
  assert.equal(history.length, 2)
  assert.deepEqual(history[0], { hash: 'abc123', author: 'user', date: 1722500000, subject: 'fix: x' })
  assert.equal(history[1]?.author, '')
  assert.equal(history[1]?.date, 0)
  assert.deepEqual(normalizeGitHistory([]), [])
}

// 3. git_error 分类：非 git 仓库/超时/其他
{
  assert.equal(classifyGitError(new Error('git_error: not a git repository')).kind, 'not-repo')
  assert.equal(classifyGitError('git_error: 非 git 仓库').kind, 'not-repo')
  assert.equal(classifyGitError('git_error: timeout after 10s').kind, 'timeout')
  assert.equal(classifyGitError('git_error: 超时').kind, 'timeout')
  assert.equal(classifyGitError('git_error: exit status 128').kind, 'failed')
}

// 4. 旧 workspaceApi 兼容 re-export（RightPanel 过渡期 import 不断）
import { normalizeWorkspaceEntries as compatNormalize } from '../src/components/right-panel/workspaceApi.ts'
assert.equal(compatNormalize([{ name: 'a', relativePath: 'a', kind: 'file' }]).length, 1)

console.log('file contracts 守卫通过')
