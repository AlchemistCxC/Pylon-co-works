/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { loadPackageStyles } from '../packageStyleRuntime.ts'
import { PluginScope } from '../pluginScope.ts'

function autoCompleteLinks(result: 'load' | 'error') {
  const appendChild = document.head.appendChild.bind(document.head)
  return vi.spyOn(document.head, 'appendChild').mockImplementation(node => {
    const appended = appendChild(node)
    queueMicrotask(() => node.dispatchEvent(new Event(result)))
    return appended
  })
}

describe('package style runtime', () => {
  it('为同一 runtime 注入全部 stylesheet，并在 scope dispose 时回收', async () => {
    const append = autoCompleteLinks('load')
    const scope = new PluginScope('style.plugin@1.0.0#run-1')

    const handle = await loadPackageStyles({
      pluginId: 'style.plugin',
      runtimeInstanceId: 'style.plugin@1.0.0#run-1',
      urls: ['pylon-plugin://style/a.css', 'pylon-plugin://style/b.css'],
      scope,
    })

    const links = [...document.head.querySelectorAll<HTMLLinkElement>('link[data-pylon-plugin-style="style.plugin"]')]
    expect(links.map(link => link.getAttribute('href'))).toEqual([
      'pylon-plugin://style/a.css',
      'pylon-plugin://style/b.css',
    ])
    expect(links.every(link => link.dataset.pylonPluginRuntime === 'style.plugin@1.0.0#run-1')).toBe(true)
    expect(links.every(link => link.media === 'not all')).toBe(true)

    handle.commit()
    expect(links.every(link => link.media === '')).toBe(true)

    await scope.dispose()
    expect(document.head.querySelectorAll('[data-pylon-plugin-style="style.plugin"]')).toHaveLength(0)
    append.mockRestore()
  })

  it('stylesheet 失败会拒绝 activation，已插入节点可由 rollback 回收', async () => {
    const append = autoCompleteLinks('error')
    const scope = new PluginScope('style.plugin@1.0.0#run-failure')

    await expect(loadPackageStyles({
      pluginId: 'style.plugin',
      runtimeInstanceId: 'style.plugin@1.0.0#run-failure',
      urls: ['pylon-plugin://style/failure.css'],
      scope,
    })).rejects.toThrow('样式加载失败')

    expect(document.head.querySelectorAll('[data-pylon-plugin-style="style.plugin"]')).toHaveLength(1)
    await scope.dispose()
    expect(document.head.querySelectorAll('[data-pylon-plugin-style="style.plugin"]')).toHaveLength(0)
    append.mockRestore()
  })

  it('无 DOM 环境声明 styles 时明确失败，空 styles 不依赖 DOM', async () => {
    const scope = new PluginScope('style.plugin@1.0.0#run-node')
    await expect(loadPackageStyles({
      pluginId: 'style.plugin',
      runtimeInstanceId: 'style.plugin@1.0.0#run-node',
      urls: ['pylon-plugin://style/node.css'],
      scope,
      resolveDocument: () => undefined,
    })).rejects.toThrow('当前运行环境没有 DOM')

    await expect(loadPackageStyles({
      pluginId: 'style.plugin',
      runtimeInstanceId: 'style.plugin@1.0.0#run-empty',
      urls: [],
      scope,
      resolveDocument: () => undefined,
    })).resolves.toMatchObject({ count: 0 })
    await scope.dispose()
  })
})
