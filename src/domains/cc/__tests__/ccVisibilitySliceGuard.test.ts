import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CC_WIDGET_GROUPS, CLI_HINT_GOVERNED_WIDGET_IDS, resolveCcHiddenWidgetIds } from '../widgetDefinitions.ts'
import { DEFAULT_CC_LAYOUT } from '../ccLayoutState.ts'
import { DEFAULTS } from '../../theme/themeDefaults.ts'
import {
  applyZonePresetReducer,
  inheritCcEmptySlice,
  setGlobalPresetReducer,
  type ThemePresetState,
} from '../../theme/presetReducer.ts'
import { DEFAULT_PRESETS, GLOBAL_PRESETS } from '../../theme/presets/index.ts'
import { ZONE_PRESET_POOL } from '../../theme/zones/index.ts'

/**
 * #266 刀2（空态收成「盒子 + 一道门」）的**防回归守卫**。
 *
 * 为什么要有它：本刀删掉的两处「按元件 / 按条件特判」——
 *   ① `EMPTY_STATE_HIDDEN_WIDGET_IDS`（代码里硬编码的空态名单）；
 *   ② `COMMAND_HINT_WIDGET_ID`（折叠逻辑里写死的元件 id）；
 * 都是 `tsc` / `lint` / `check:solid` **看不见**的东西（删掉它们不会让任何门禁变红）。
 * 同款做法见同目录的 `ccVisibilityDeclarationGuard.test.ts`（⑰ 的守卫，读生产源码 + 剥注释）。
 *
 * 第二条守卫（★ 施工单 §四-5 点名要求的「切面键集」守卫）：名单搬进**预设数据**后，
 * 它单独维护、没有编译器约束 ⇒ 元件增减 / 改名时**漏同步就是静默坏**。
 * 判据两条：**出厂每套 cc 条目都带非空空态切面** + **两种切面里的 id 必须都是当前可拖元件**。
 */
const SOURCE_PATH = new URL('../widgetDefinitions.ts', import.meta.url)
const SOURCE = readFileSync(SOURCE_PATH, 'utf8')

/** 剥掉注释：说明性注释**会提到**被删的名字（刀2 要求在原位留口径说明），不该被误判。 */
const stripComments = (source: string) => source
  .replaceAll(/\/\*[\s\S]*?\*\//g, '')
  .replaceAll(/(?<!:)\/\/[^\n]*/g, '')

/** 刀2 删掉的两处特判：出现在 `widgetDefinitions.ts` 的**代码**里即回归。 */
const BANNED_TOKENS = [
  { token: 'EMPTY_STATE_HIDDEN_WIDGET_IDS', what: '代码侧硬编码的空态名单' },
  { token: 'COMMAND_HINT_WIDGET_ID', what: '折叠逻辑里写死的元件 id' },
] as const

/** 出厂 cc 区域的 10 条条目（每桶 5 条 = 该桶的 5 套预设各一条）。 */
const FACTORY_CC_ENTRIES = (['gui', 'terminal'] as const)
  .flatMap(bucket => ZONE_PRESET_POOL[bucket].cc)

/** 出厂空态切面的键集（★ 字面量钉住：改它 = 显式动作，改哪条、为什么都进 diff）。 */
const EXPECTED_FACTORY_EMPTY_SLICE = [
  'cc-command-hint', 'cc-send-button', 'mode', 'model', 'reasoning', 'tokens',
]

/** 切面取值允许的 id 全集 = 当前可拖元件（由定义表派生）⇒ 元件增减 / 改名即红。 */
const DRAGGABLE_IDS: readonly string[] = Object.keys(DEFAULT_CC_LAYOUT.placements)

describe('#266 刀2 · 两处「按元件特判」不得回归（源码级）', () => {
  it('扫描面非空、且确实剥掉了注释（防"守卫自己空转"）', () => {
    expect(SOURCE.length).toBeGreaterThan(10_000)
    const stripped = stripComments(SOURCE)
    // 正控：说明性注释里点名提到的两个名字，剥完必须消失（否则下面那条断言会自证清白）
    expect(SOURCE).toContain('EMPTY_STATE_HIDDEN_WIDGET_IDS')
    expect(SOURCE).toContain('COMMAND_HINT_WIDGET_ID')
    expect(stripped).not.toContain('EMPTY_STATE_HIDDEN_WIDGET_IDS')
    expect(stripped).not.toContain('COMMAND_HINT_WIDGET_ID')
    // 正控：代码本体仍在（表/规则没整文件消失）
    expect(stripped).toContain('resolveCcHiddenWidgetIds')
  })

  it('两处特判在代码里零命中（任何一项回来即红）', () => {
    const stripped = stripComments(SOURCE)
    const hits = BANNED_TOKENS
      .filter(({ token }) => stripped.includes(token))
      .map(({ token, what }) => `${token}（${what}）`)
    expect(hits, '按元件 / 按条件的硬编码名单又回到了定义表；若确要复活，改这条测试是显式动作').toEqual([])
  })

  it('折叠的管辖集改由**件声明**派生（表是唯一出处，且折叠确实读它）', () => {
    // 派生结果来自表里的声明（不是另一份平行清单）
    const declared = CC_WIDGET_GROUPS.filter(row => row.cliHintGoverned === true).map(row => row.id)
    expect(declared).toEqual([...CLI_HINT_GOVERNED_WIDGET_IDS])
    // 非空（否则"只读声明"会退化成"永远空集"的假绿）
    expect(CLI_HINT_GOVERNED_WIDGET_IDS.length).toBeGreaterThan(0)
    // 折叠的输出 = 这份派生集：把声明从表里挪走一件（或写死一个别的 id），这条会红
    expect(resolveCcHiddenWidgetIds({ ccHidden: [], ccHiddenEmpty: [], cliHintMode: 'hidden' })).toEqual([...CLI_HINT_GOVERNED_WIDGET_IDS])
  })
})

describe('#266 刀2 · 切面键集守卫（出厂预设数据面）', () => {
  it('出厂 cc 条目 10 条（每桶 5），正控：数据面与可拖 id 集都非空', () => {
    expect(FACTORY_CC_ENTRIES).toHaveLength(10)
    expect(GLOBAL_PRESETS).toHaveLength(10)
    expect(DRAGGABLE_IDS).toHaveLength(7)
  })

  it('★ 每套出厂预设都**带**空态切面（缺了不是报错，是空态静默回落到常态 ⇒ 视觉悄悄变）', () => {
    const missing = FACTORY_CC_ENTRIES
      .filter(entry => !Array.isArray(entry.values.ccHiddenEmpty) || entry.values.ccHiddenEmpty.length === 0)
      .map(entry => `${entry.mode}/cc/${entry.id}`)
    expect(missing, '出厂 cc 条目漏了空态切面（或写成空数组 = 等于没写）').toEqual([])
  })

  it('★ 出厂空态切面的键集逐条锁死（排序后 6 条字面量）', () => {
    for (const entry of FACTORY_CC_ENTRIES) {
      expect([...entry.values.ccHiddenEmpty as string[]].sort(), `${entry.mode}/cc/${entry.id} 空态切面键集`)
        .toEqual([...EXPECTED_FACTORY_EMPTY_SLICE].sort())
    }
  })

  it('★ 两种切面的取值必须都是**当前可拖元件**的 id（元件增减 / 改名漏同步即红）', () => {
    const offenders: string[] = []
    for (const entry of FACTORY_CC_ENTRIES) {
      const at = `${entry.mode}/cc/${entry.id}`
      for (const [key, slice] of [['ccHidden', entry.values.ccHidden], ['ccHiddenEmpty', entry.values.ccHiddenEmpty]] as const) {
        if (slice === undefined) continue
        if (!Array.isArray(slice)) {
          offenders.push(`${at}.${key} 不是 id 名单（形状不对）`)
          continue
        }
        for (const id of slice as string[]) {
          if (!DRAGGABLE_IDS.includes(id)) offenders.push(`${at}.${key} 含非当前元件 id：${id}`)
        }
      }
    }
    expect(offenders, '切面里出现了定义表里没有（或已不可拖）的 id —— 元件增减后请同步预设数据').toEqual([])
  })

  it('★ 基准空态切面 = 出厂那 6 件（新装 / 未登记界面模式下空态仍「极简」）', () => {
    // 这一份是刀2 之前硬编码在 `widgetDefinitions.ts` 里的名单，逐字搬到 DEFAULTS 当**基准**：
    // 空数组会让新装的空态突然多出状态行与发送按钮（产品行为变化），故基准值非空。
    expect([...DEFAULTS.ccHiddenEmpty].sort()).toEqual([...EXPECTED_FACTORY_EMPTY_SLICE].sort())
    // 常态基准仍是"什么都不藏"（活跃会话下默认全显示）
    expect(DEFAULTS.ccHidden).toEqual([])
  })

  it('★ 两条默认预设（重置主题的落点）同样带非空空态切面', () => {
    for (const bucket of ['gui', 'terminal'] as const) {
      const preset = DEFAULT_PRESETS[bucket]
      const slice = preset.theme.ccHiddenEmpty ?? []
      expect([...slice].sort(), `${preset.name} 空态切面键集`).toEqual([...EXPECTED_FACTORY_EMPTY_SLICE].sort())
      for (const id of slice) {
        expect(DRAGGABLE_IDS, `${preset.name} 空态切面含非当前元件 id：${id}`).toContain(id)
      }
    }
  })
})

describe('#266 刀2 · 「预设没写空态切面 ⇒ 回落常态切面」落在**预设落值**这一步', () => {
  // 判据按"预设里有没有这个键"（键不在 ⇒ 抄常态；写了空数组 = 显式选择，照用）。
  // 读侧（`resolveCcHiddenWidgetIds`）是纯二选一，读不出这个区别 —— 故回落必须在这一层验。
  const state = { ...structuredClone(DEFAULTS), customPresets: [] } as unknown as ThemePresetState

  it('★ 区域预设（cc）：只带常态 ⇒ 落值后空态切面 = 它自己的常态切面', () => {
    const patch = applyZonePresetReducer(state, 'cc', '只带常态的区域预设', { ccHidden: ['model', 'tokens'] })
    expect(patch.ccHidden).toEqual(['model', 'tokens'])
    expect(patch.ccHiddenEmpty, '缺省必须回落常态切面').toEqual(['model', 'tokens'])
  })

  it('★ 写了就用写的（显式空数组 = 空态不藏任何件，不与"没写"混同）', () => {
    const written = applyZonePresetReducer(state, 'cc', '带空态切面的区域预设', { ccHidden: ['tokens'], ccHiddenEmpty: ['model'] })
    expect(written.ccHiddenEmpty).toEqual(['model'])
    const explicitEmpty = applyZonePresetReducer(state, 'cc', '空态不藏的预设', { ccHidden: ['tokens'], ccHiddenEmpty: [] })
    expect(explicitEmpty.ccHiddenEmpty, '显式空数组必须保住（否则空态无法表达"不藏任何件"）').toEqual([])
  })

  it('非 cc 区 / 两样都没写 ⇒ 不回落；且回落是纯函数（不改传入对象）', () => {
    const otherZone = applyZonePresetReducer(state, 'chat', 'x', { chatBg: '#123456' })
    expect(otherZone.ccHiddenEmpty, '非 cc 区不该凭空长出空态切面').toBeUndefined()
    const input = { ccHidden: ['mode'] }
    expect(inheritCcEmptySlice(input)).toEqual({ ccHidden: ['mode'], ccHiddenEmpty: ['mode'] })
    expect(input, '纯函数：不改输入').toEqual({ ccHidden: ['mode'] })
    expect(inheritCcEmptySlice({ chatBg: '#fff' })).toEqual({ chatBg: '#fff' })
  })

  it('★ 整份主题路径（重置主题 / 旧参考实现）同样回落，且不被 DEFAULTS 基准盖住', () => {
    const patch = setGlobalPresetReducer('只带常态的预设', { ccHidden: ['tokens'] })
    expect(patch.ccHiddenEmpty).toEqual(['tokens'])
    // 正控：若铺底（DEFAULTS 的 6 件基准）赢了，这里会是那 6 件 —— 那"回落"就是假绿
    expect([...patch.ccHiddenEmpty as string[]].sort()).not.toEqual([...EXPECTED_FACTORY_EMPTY_SLICE].sort())
  })
})
