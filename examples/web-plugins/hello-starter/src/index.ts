/**
 * starter.hello — 插件开发脚手架（API 1.0）。
 *
 * 演示外置插件的五个最常用面：
 *   1. commands.register —— 注册后自动获得 CLI 入口（command exec starter.hello.ping）
 *   2. hooks.register    —— pipeline 修改用户消息 / notification 观察回合与会话
 *   3. sessions.setPluginMetadata —— 每会话隔离元数据
 *   4. scope 纪律        —— 所有副作用经 scope 登记，停用时可回收
 *   5. 隔离设置页        —— SDK createSettingsSurface 封装 host:input / settings:set 协议
 *
 * 全部通过 @pylon/plugin-sdk 引用宿主契约；本入口打成单 ESM bundle。
 */
import { createPluginLogger, createSettingsSurface, definePlugin } from '@pylon/plugin-sdk'

interface StarterSettings {
  greetingName: string
  decorate: boolean
}

let settings: StarterSettings = { greetingName: 'Pylon', decorate: false }

export default definePlugin({
  async activate(context) {
    const log = createPluginLogger(context.identity.pluginId)
    log.info('activate', context.identity.runtimeInstanceId)

    // 1) Command：execute 后即可 pylon-cli command exec starter.hello.ping --args '{"name":"..."}'
    context.commands.register({
      id: 'starter.hello.ping',
      name: 'starter-ping',
      description: '返回插件运行时身份与当前问候设置',
      priority: 100,
      execute: ({ args }) => {
        const name = (args as { name?: string } | undefined)?.name
        return {
          pong: true,
          greeting: `Hello, ${name ?? settings.greetingName}`,
          decorate: settings.decorate,
          runtimeInstanceId: context.identity.runtimeInstanceId,
        }
      },
    })

    // 2) Hook：pipeline 可改写事件；notification 只观察
    context.hooks.register('message.user.beforeSend', {
      id: 'starter.hello.decorate',
      mode: 'pipeline',
      priority: 100,
      execution: 'blocking',
      timeoutMs: 1000,
      failurePolicy: 'continue',
      handler: ({ event }) => {
        if (!settings.decorate) return { action: 'continue' }
        return { action: 'continue', event: { ...(event as Record<string, unknown>), starterDecorated: true } }
      },
    })

    // 3) 会话创建后打一个插件命名空间的标签（随会话持久、按 plugin id 隔离）
    context.hooks.register('session.created', {
      id: 'starter.hello.session-tag',
      mode: 'notification',
      execution: 'background',
      failurePolicy: 'continue',
      handler: ({ event }) => {
        const sessionId = (event as { sessionId?: string }).sessionId
        if (typeof sessionId === 'string') {
          context.sessions.setPluginMetadata(sessionId, { taggedBy: context.identity.pluginId, at: Date.now() })
          log.info('session tagged', sessionId)
        }
      },
    })

    context.hooks.register('turn.started', {
      id: 'starter.hello.turn-watch',
      mode: 'notification',
      execution: 'background',
      failurePolicy: 'continue',
      handler: ({ event }) => log.info('turn started', event),
    })

    // 4) Scope 纪律：定时器与监听器都会在停用/热更换时被宿主回收
    const startedAt = Date.now()
    context.scope.setInterval(() => {
      log.info(`uptime ${Math.round((Date.now() - startedAt) / 1000)}s`)
    }, 60_000)

    // 5) 隔离设置页：声明字段，SDK 负责渲染与 host:input / settings:set 协议
    context.ui.registerSurface(
      createSettingsSurface({
        id: 'starter.hello.settings',
        description: 'Starter 示例：字段改动经 settings:set 持久化到插件命名空间。',
        fields: [
          { type: 'text', key: 'greetingName', label: '问候名', placeholder: 'Pylon' },
          { type: 'toggle', key: 'decorate', label: '在用户消息上附加 starterDecorated 标记' },
        ],
        onChange: (key, value) => {
          settings = { ...settings, [key]: value as never }
          log.info('setting changed', key, value)
        },
      }),
    )
    context.settings.registerPage({
      id: 'starter.hello.settings-page',
      label: 'Starter Hello',
      description: '演示隔离 Surface 与设置持久化协议',
      order: 900,
      renderKind: 'isolated-surface',
      surfaceId: 'starter.hello.settings',
    })
  },

  async deactivate() {
    console.info('[starter.hello] deactivated')
  },
})
