import { describe, expect, it, vi } from 'vitest'
import { classifySaveError, saveWorkspaceText } from '../workspaceWrite'

// I08-A-FE-02：write_workspace_text 前端收口——保存经 typed 调用带
// source/relativePath/content/expectedBaseline/force；conflict/too_large 本地分类。

function transport(impl: (cmd: string, args?: unknown) => Promise<unknown>) {
  return { invoke: impl }
}

describe('saveWorkspaceText write_workspace_text 收口', () => {
  it('保存调用带 source/relativePath/content/expectedBaseline/force 并 normalize 响应', async () => {
    const invoke = vi.fn().mockResolvedValue({
      relativePath: 'src/a.ts',
      content: 'const x = 2',
      bytesRead: 11,
      totalBytes: 11,
      truncated: false,
    })
    const result = await saveWorkspaceText(transport(invoke), {
      source: 'ws-a',
      relativePath: 'src/a.ts',
      content: 'const x = 2',
      expectedBaseline: 'const x = 1',
    })
    expect(invoke).toHaveBeenCalledWith('write_workspace_text', {
      source: 'ws-a',
      relativePath: 'src/a.ts',
      content: 'const x = 2',
      expectedBaseline: 'const x = 1',
      force: false,
    })
    expect(result).toEqual({ relativePath: 'src/a.ts', content: 'const x = 2', bytesRead: 11, totalBytes: 11, truncated: false, encoding: 'utf-8' })
  })

  it('无 expectedBaseline 时传 null，force=true 原样透传（覆盖保存）', async () => {
    const invoke = vi.fn().mockResolvedValue({ relativePath: 'b.ts', content: 'y', bytesRead: 1, totalBytes: 1, truncated: false })
    await saveWorkspaceText(transport(invoke), {
      source: 'ws-a',
      relativePath: 'b.ts',
      content: 'y',
      force: true,
    })
    expect(invoke).toHaveBeenCalledWith('write_workspace_text', {
      source: 'ws-a',
      relativePath: 'b.ts',
      content: 'y',
      expectedBaseline: null,
      force: true,
    })
  })

  it('损坏响应 normalize 为 null（不崩）', async () => {
    const invoke = vi.fn().mockResolvedValue({ nope: true })
    const result = await saveWorkspaceText(transport(invoke), {
      source: 'ws-a',
      relativePath: 'b.ts',
      content: 'y',
    })
    expect(result).toBeNull()
  })

  it('后端拒绝时原样抛出（冲突/too_large 由调用方分类）', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('conflict: 磁盘文件已被外部修改，保存已拒绝'))
    await expect(saveWorkspaceText(transport(invoke), {
      source: 'ws-a',
      relativePath: 'b.ts',
      content: 'y',
      expectedBaseline: 'z',
    })).rejects.toThrow('conflict')
  })
})

describe('classifySaveError conflict/too_large 本地分类', () => {
  it('conflict → code conflict', () => {
    const detail = classifySaveError(new Error('conflict: 磁盘文件已被外部修改，保存已拒绝'))
    expect(detail.code).toBe('conflict')
    expect(detail.message).toContain('conflict')
  })

  it('too_large → code too_large', () => {
    const detail = classifySaveError(new Error('too_large: 文件过大，无法编辑保存'))
    expect(detail.code).toBe('too_large')
  })

  it('not_found/io 复用既有分类，未知 → unknown', () => {
    expect(classifySaveError(new Error('not_found: 文件不存在')).code).toBe('not_found')
    expect(classifySaveError(new Error('io error: 写入失败')).code).toBe('io')
    expect(classifySaveError('boom').code).toBe('unknown')
  })

  it('字符串错误不崩并保留消息', () => {
    const detail = classifySaveError('boom')
    expect(detail.message).toBe('boom')
  })
})
