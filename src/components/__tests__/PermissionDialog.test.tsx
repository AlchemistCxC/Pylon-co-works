// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PermissionDialog from '../PermissionDialog.tsx'
import { useRuntimeStore } from '../../runtimeStore'
import { useIdentityStore } from '../../identityStore'
import { resetStores } from '../../test/resetStores'
import type { PermissionRequest } from '../../domains/permission/permissionTypes.ts'
import type { PermissionAgentSlice, PermissionRequestState } from '../../domains/permission/permissionState.ts'

// 下沉自 scripts/test-permission-dialog.mts（P91 A2）：弹窗接线行为
// （按钮映射纯函数断言由 domains/permission/__tests__/permissionButtons.test.ts 承担）。

vi.mock('../../infrastructure/acp/permissionController', () => ({
  getPermissionController: () => ({ choose: chooseMock }),
}))

const chooseMock = vi.fn()

function buildActive(request: Partial<PermissionRequest>, status: PermissionRequestState['status']): PermissionRequestState {
  return {
    request: {
      requestId: 'req-1',
      options: [{ optionId: 'allow_once' }, { optionId: 'reject_once' }],
      ...request,
    } as PermissionRequest,
    status,
    receivedAt: 1,
  }
}

function wire(request: Partial<PermissionRequest> = {}, agentId = 'peri', status: PermissionRequestState['status'] = 'pending'): void {
  useIdentityStore.setState({ activeAgent: agentId })
  useRuntimeStore.setState(state => {
    const previous = state.permission.byAgent[agentId]
    const slice: PermissionAgentSlice = { active: buildActive(request, status), queued: previous?.queued ?? [] }
    return {
      permission: {
        ...state.permission,
        byAgent: { ...state.permission.byAgent, [agentId]: slice },
      },
    }
  })
}

describe('PermissionDialog 接线', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    chooseMock.mockClear()
  })
  afterEach(async () => {
    const { cleanup } = await import('@testing-library/react')
    cleanup()
  })

  it('无 active 请求时渲染 null', () => {
    const { container } = render(<PermissionDialog />)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('弹窗展示 prompt/toolCallId，按钮按 wire 顺序动态生成', () => {
    wire({
      title: '文件写入',
      prompt: '允许写入 /tmp/a.txt？',
      toolCallId: 'call-9',
      options: [{ optionId: 'allow_once', label: '允许' }, { optionId: 'reject_once' }],
    })
    render(<PermissionDialog />)
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', '工具权限请求')
    expect(screen.getByText('文件写入')).toBeInTheDocument()
    expect(screen.getByText(/toolCallId: call-9/)).toBeInTheDocument()
    expect(screen.getByText('允许写入 /tmp/a.txt？')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '允许' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'reject_once' })).toBeInTheDocument()
  })

  it('点击按钮经 controller 原样回传 requestId 与 optionId', () => {
    wire()
    render(<PermissionDialog />)
    fireEvent.click(screen.getByRole('button', { name: 'allow_once' }))
    expect(chooseMock).toHaveBeenCalledWith('req-1', 'allow_once')
  })

  it('answering 期间禁用全部按钮防双击', () => {
    wire({}, 'peri', 'answering')
    render(<PermissionDialog />)
    for (const name of ['allow_once', 'reject_once']) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
    fireEvent.click(screen.getByRole('button', { name: 'allow_once' }))
    expect(chooseMock).not.toHaveBeenCalled()
  })

  it('后台 agent 的请求不展示（按 agent 切片隔离）', () => {
    // 请求停在后台 hermes 名下，当前 agent 是 peri 且无 active ⇒ 弹窗不出现
    useIdentityStore.setState({ activeAgent: 'peri' })
    useRuntimeStore.setState(state => {
      const previous = state.permission.byAgent['hermes']
      const slice: PermissionAgentSlice = {
        active: {
          request: { requestId: 'req-bg', options: [{ optionId: 'allow_once' }] } as PermissionRequest,
          status: 'pending',
          receivedAt: 1,
        },
        queued: previous?.queued ?? [],
      }
      return {
        permission: { ...state.permission, byAgent: { ...state.permission.byAgent, hermes: slice } },
      }
    })
    render(<PermissionDialog />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
