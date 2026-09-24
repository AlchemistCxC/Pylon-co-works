import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CC_WIDGET_GROUPS } from '../widgetDefinitions.ts'

/**
 * #266 ⑰（显隐只剩「值 + 语境名单」）的**防回归守卫**：**元件行上不得再长出显隐申明**。
 *
 * 为什么要有它：这次撤掉的三样（`inActiveSession` / `conditions` / `hiddenInEmptyState`）与
 * 条件表（`CC_VISIBILITY_CONDITIONS`）都是"**元件自己申明自己显不显示**"——正是用户 2026-09-23
 * 明确否掉的形状（原话：「如果要记『这里不显示』，应该是在这里注明 a 不显示，而不是 a 申明在这里不显示」）。
 * 删掉它们**不会**让任何门禁变红（`tsc` / `lint` / `check:solid` 都看不见"有没有这个东西"），
 * 所以必须显式钉住。做法与先例一致：`ccDeadDataGuard.test.ts`（读生产源码文本 + 剥注释）、
 * `workbenchChromeCss.solid.test.ts`（CSS 侧守卫）。
 *
 * 判据两条，缺一不可：
 * 1. **源码级**：`widgetDefinitions.ts` 里（**剥注释后**）这几个名字零命中；
 * 2. **对象级**：表里每一行都不带这三个键（源码级扫描抓不到"换个写法又申明一次"，对象级能）。
 *
 * ★ 这不是教条：将来若确要复活其中任何一项，**改这条测试是一个显式动作** —— 改哪一条、为什么，
 *   都会进 diff。这正是它存在的意义。
 */
const SOURCE_PATH = new URL('../widgetDefinitions.ts', import.meta.url)
const SOURCE = readFileSync(SOURCE_PATH, 'utf8')

/** 剥掉注释：说明性注释**会提到**被撤的名字（本文件所在任务就要求在原位留口径说明），不该被误判。 */
const stripComments = (source: string) => source
  .replaceAll(/\/\*[\s\S]*?\*\//g, '')
  .replaceAll(/(?<!:)\/\/[^\n]*/g, '')

/** ⑰ 撤掉的四样：出现在 `widgetDefinitions.ts` 的**代码**里即回归。 */
const BANNED_TOKENS = [
  { token: 'inActiveSession', what: '行上「活跃会话里显示/收起」申明' },
  { token: 'conditions', what: '行上「运行期状态检测条件」申明' },
  { token: 'hiddenInEmptyState', what: '行上「空态隐藏」申明' },
  { token: 'CC_VISIBILITY_CONDITIONS', what: '条件表本体' },
] as const

describe('#266 ⑰ · 元件不得再自己申明显隐', () => {
  it('扫描面非空、且确实剥掉了注释（防"守卫自己空转"）', () => {
    // 正控 1：文件真有内容（被删光/换路径 ⇒ 空串匹配一切都会"绿"）
    expect(SOURCE.length).toBeGreaterThan(10_000)
    // 正控 2：剥注释生效 —— 说明性注释里点名提到的那些名字，剥完必须消失
    const stripped = stripComments(SOURCE)
    expect(SOURCE).toContain('inActiveSession')
    expect(stripped).not.toContain('inActiveSession')
    expect(stripped).toContain('isWidgetVisible')
  })

  it('四样被撤的显隐申明在代码里零命中（任何一项回来即红）', () => {
    const stripped = stripComments(SOURCE)
    const hits = BANNED_TOKENS
      .filter(({ token }) => stripped.includes(token))
      .map(({ token, what }) => `${token}（${what}）`)
    expect(hits, '元件侧显隐申明又回到了定义表；若确要复活，改这条测试是显式动作').toEqual([])
  })

  it('对象级：表里 8 行都不带这三个键', () => {
    const offenders: string[] = []
    for (const row of CC_WIDGET_GROUPS) {
      for (const key of ['inActiveSession', 'conditions', 'hiddenInEmptyState'] as const) {
        if (Object.hasOwn(row, key)) offenders.push(`${row.id}.${key}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('正控：表本体仍在 8 行（否则上面的断言会因为"表整个没了"而假绿）', () => {
    expect(CC_WIDGET_GROUPS).toHaveLength(8)
    expect(CC_WIDGET_GROUPS.map(row => row.id)).toContain('cc-command-hint')
    expect(CC_WIDGET_GROUPS.filter(row => row.type === 'widget')).toHaveLength(7)
  })
})
