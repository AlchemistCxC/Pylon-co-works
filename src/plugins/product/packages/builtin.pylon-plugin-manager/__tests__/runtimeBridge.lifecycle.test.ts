import { describe, expect, it } from 'vitest'
import { getPluginManagerRuntimeBridge } from '../runtimeBridge.ts'
import type { PluginManagementApi } from '../../../../../sdk/index.ts'

/**
 * review P1-1/B：bridge 清除按持有者判定——parallel 热替换时新实例先
 * activate、旧实例后 deactivate，旧实例的清除不得覆盖新实例的装配。
 */
function fakeApi(): PluginManagementApi {
  return {} as unknown as PluginManagementApi
}

describe('plugin manager runtime bridge ownership (review P1-1/B)', () => {
  it('keeps the new instance assembly when the old instance deactivates after hot-swap', () => {
    const bridge = getPluginManagerRuntimeBridge()
    const newApi = fakeApi()

    // 旧实例激活（上一代）
    bridge.setManagement(fakeApi(), 'mgr#run-1')
    expect(bridge.getManagement()).toBeDefined()
    // parallel 热替换：新实例先 activate
    bridge.setManagement(newApi, 'mgr#run-2')
    expect(bridge.getManagement()).toBe(newApi)
    // 旧实例后 deactivate：不得清掉新实例的装配
    bridge.clearManagement('mgr#run-1')
    expect(bridge.getManagement()).toBe(newApi)
    // 新实例自己停用：才真正清除
    bridge.clearManagement('mgr#run-2')
    expect(bridge.getManagement()).toBeUndefined()
  })
})
