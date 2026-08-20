// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import { PluginScope } from '../../../plugin-runtime/pluginScope.ts'
import { mountFirstPartyStyleAssets } from '../firstPartyStyleRuntime.ts'

const scopes: PluginScope[] = []
afterEach(async () => {
  await Promise.all(scopes.splice(0).map(scope => scope.dispose()))
  document.head.querySelectorAll('[data-pylon-plugin-style="builtin.test"]')
    .forEach(node => node.remove())
})

describe('first-party style runtime', () => {
  it('激活时按 owner/runtime/path 插入 style，并随 PluginScope 回收', async () => {
    const identity = createPluginIdentity('builtin.test', 'run-1')
    const scope = new PluginScope(identity.key)
    scopes.push(scope)

    mountFirstPartyStyleAssets('builtin.test', identity.key, scope, [
      { path: './styles/a.css', css: '.a { color: red; }' },
      { path: './styles/b.css', css: '.b { color: blue; }' },
    ])

    const styles = [...document.head.querySelectorAll<HTMLStyleElement>('style[data-pylon-plugin-style="builtin.test"]')]
    expect(styles).toHaveLength(2)
    expect(styles.map(style => style.dataset.pylonPluginRuntime)).toEqual([identity.key, identity.key])
    expect(styles.map(style => style.dataset.pylonPluginStylePath)).toEqual(['./styles/a.css', './styles/b.css'])
    expect(styles.map(style => style.textContent)).toEqual(['.a { color: red; }', '.b { color: blue; }'])

    await scope.dispose()
    expect(document.head.querySelectorAll('[data-pylon-plugin-style="builtin.test"]')).toHaveLength(0)
  })

  it('没有 DOM 时跳过第一方 UI side effect，空列表保持可用', () => {
    const identity = createPluginIdentity('builtin.test', 'run-no-dom')
    const scope = new PluginScope(identity.key)
    scopes.push(scope)

    expect(() => mountFirstPartyStyleAssets('builtin.test', identity.key, scope, [], undefined)).not.toThrow()
    expect(() => mountFirstPartyStyleAssets('builtin.test', identity.key, scope, [
      { path: './styles/a.css', css: '.a{}' },
    ], null)).not.toThrow()
  })
})
