import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CC_WIDGET_GROUPS, CLI_HINT_GOVERNED_WIDGET_IDS, resolveCcHiddenWidgetIds } from '../widgetDefinitions.ts'
import { DEFAULT_CC_LAYOUT } from '../ccLayoutState.ts'
import { DEFAULTS } from '../../theme/themeDefaults.ts'
import {
  applyZonePresetReducer,
  type ThemePresetState,
} from '../../theme/presetReducer.ts'
import { DEFAULT_PRESETS, GLOBAL_PRESETS } from '../../theme/presets/index.ts'
import { ZONE_PRESET_POOL } from '../../theme/zones/index.ts'

/**
 * #266 刀2（空态收成「盒子 + 一道门」）→ **刀4（结构 C：主管表 + 空态再藏）** 的**防回归守卫**。
 *
 * 为什么要有它：刀2 删掉的两处「按元件 / 按条件特判」——
 *   ① `EMPTY_STATE_HIDDEN_WIDGET_IDS`（代码里硬编码的空态名单）；
 *   ② `COMMAND_HINT_WIDGET_ID`（折叠逻辑里写死的元件 id）；
 * 都是 `tsc` / `lint` / `check:solid` **看不见**的东西（删掉它们不会让任何门禁变红）。
 * 同款做法见同目录的 `ccVisibilityDeclarationGuard.test.ts`（⑰ 的守卫，读生产源码 + 剥注释）。
 *
 * ★ 刀4 把判据从「两份平权表 + 门选一份」换成「**主管表 + 再藏表**」，本文件的判据随之改写：
 * - **数据级**：出厂每套 cc 条目都带**非空再藏表**；两份表里的 id 必须都是当前可拖元件；
 *   基准再藏表 = 出厂那 6 件；两条默认预设同样带非空再藏表。
 * - **行为级**：`再藏` **只能叠加、不能抵消**（生效名单 = `门 ? 主管 ∪ 再藏 : 主管`，去重）
 *   ⇒ 不变式 **空态隐藏 ⊇ 常态隐藏**（核心：空态**不能**"放出"常态藏着的件）。
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

/** 出厂**再藏表**的键集（★ 字面量钉住：改它 = 显式动作，改哪条、为什么都进 diff）。 */
const EXPECTED_FACTORY_EMPTY_SLICE = [
  'cc-command-hint', 'cc-send-button', 'mode', 'model', 'reasoning', 'tokens',
]

/** 表取值允许的 id 全集 = 当前可拖元件（由定义表派生）⇒ 元件增减 / 改名即红。 */
const DRAGGABLE_IDS: readonly string[] = Object.keys(DEFAULT_CC_LAYOUT.placements)

describe('#266 刀2/刀4 · 两处「按元件特判」不得回归（源码级）', () => {
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

describe('#266 刀2/刀4 · 两份表的键集守卫（出厂预设数据面）', () => {
  it('出厂 cc 条目 10 条（每桶 5），正控：数据面与可拖 id 集都非空', () => {
    expect(FACTORY_CC_ENTRIES).toHaveLength(10)
    expect(GLOBAL_PRESETS).toHaveLength(10)
    expect(DRAGGABLE_IDS).toHaveLength(7)
  })

  it('★ 每套出厂预设都**带**非空再藏表（缺了不是报错，是该套预设的空态悄悄退回 DEFAULTS 基准）', () => {
    // ★ 刀4 口径：缺这一项 ⇒ 该键不进 patch ⇒ 由 `DEFAULTS.ccHiddenEmpty`（出厂那 6 件）兜底。
    //   对"出厂预设"来说那不是它想表达的值 ⇒ 仍要求显式带一份（缺了 / 写成空数组都算漏）。
    const missing = FACTORY_CC_ENTRIES
      .filter(entry => !Array.isArray(entry.values.ccHiddenEmpty) || entry.values.ccHiddenEmpty.length === 0)
      .map(entry => `${entry.mode}/cc/${entry.id}`)
    expect(missing, '出厂 cc 条目漏了再藏表（或写成空数组 = 该套不打算多藏，与"漏写"同形）').toEqual([])
  })

  it('★ 出厂再藏表的键集逐条锁死（排序后 6 条字面量）', () => {
    for (const entry of FACTORY_CC_ENTRIES) {
      expect([...entry.values.ccHiddenEmpty as string[]].sort(), `${entry.mode}/cc/${entry.id} 再藏表键集`)
        .toEqual([...EXPECTED_FACTORY_EMPTY_SLICE].sort())
    }
  })

  it('★ 两份表的取值必须都是**当前可拖元件**的 id（元件增减 / 改名漏同步即红）', () => {
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
    expect(offenders, '名单里出现了定义表里没有（或已不可拖）的 id —— 元件增减后请同步预设数据').toEqual([])
  })

  it('★ 出厂每套预设满足「再藏 ⊇ 主管」⇒ 并集结果与刀2/刀3 时期逐字相同（零观感变化）', () => {
    // 这一条是"改结构不改观感"的**数据依据**：只有满足它，`门 ? 主管 ∪ 再藏 : 主管` 才等于
    // 旧口径"门开取空态表"的结果。任何一套破了它，本刀的观感就变了 ⇒ 必须显式看见。
    const offenders = FACTORY_CC_ENTRIES
      .filter(entry => {
        const base = (entry.values.ccHidden as string[] | undefined) ?? []
        const extra = (entry.values.ccHiddenEmpty as string[] | undefined) ?? []
        return base.some(id => !extra.includes(id))
      })
      .map(entry => `${entry.mode}/cc/${entry.id}`)
    expect(offenders, '这套出厂预设的主管表里有件不在再藏表里 ⇒ C 的并集与旧口径不再等价').toEqual([])
  })

  it('★ 基准再藏表 = 出厂那 6 件（新装 / 未登记界面模式下空态仍「极简」）', () => {
    // 这一份是刀2 之前硬编码在 `widgetDefinitions.ts` 里的名单，逐字搬到 DEFAULTS 当**基准**：
    // ★ 刀4 起它是"**再藏**"的基准（叠在主管表之上），不再是"整份空态名单"。
    expect([...DEFAULTS.ccHiddenEmpty].sort()).toEqual([...EXPECTED_FACTORY_EMPTY_SLICE].sort())
    // 常态基准仍是"什么都不藏"（活跃会话下默认全显示）
    expect(DEFAULTS.ccHidden).toEqual([])
  })

  it('★ 两条默认预设（重置主题的落点）同样带非空再藏表', () => {
    for (const bucket of ['gui', 'terminal'] as const) {
      const preset = DEFAULT_PRESETS[bucket]
      const slice = preset.theme.ccHiddenEmpty ?? []
      expect([...slice].sort(), `${preset.name} 再藏表键集`).toEqual([...EXPECTED_FACTORY_EMPTY_SLICE].sort())
      for (const id of slice) {
        expect(DRAGGABLE_IDS, `${preset.name} 再藏表含非当前元件 id：${id}`).toContain(id)
      }
    }
  })
})

describe('#266 刀4 · 「再藏只能叠加、不能抵消」落在**读侧合并**这一步', () => {
  it('★ 门开 = 主管 ∪ 再藏（去重）；门关 = 只主管', () => {
    // 不相交：两边各藏各的 ⇒ 空态拿到并集（旧口径"门开只读再藏表"会漏掉 tokens）
    expect(resolveCcHiddenWidgetIds({ ccHidden: ['tokens'], ccHiddenEmpty: ['model'], isEmpty: true }))
      .toEqual(['tokens', 'model'])
    expect(resolveCcHiddenWidgetIds({ ccHidden: ['tokens'], ccHiddenEmpty: ['model'], isEmpty: false }))
      .toEqual(['tokens'])
    // 相交：去重（同一件不出现两次 —— 去重不是可选的，名单会被渲染与计数逐件消费）
    expect(resolveCcHiddenWidgetIds({ ccHidden: ['tokens', 'model'], ccHiddenEmpty: ['model'], isEmpty: true }))
      .toEqual(['tokens', 'model'])
  })

  it('★ 核心不变式：再藏**抵消不掉**主管表 —— 空态藏着的件 ⊇ 常态藏着的件', () => {
    // 「再藏表是主管表的子集」也不行：主管表里那件在空态**照样**藏着
    // （旧口径下这一组合表达的是"常态藏、空态放出来" —— C 明确取消这种能力）
    expect(resolveCcHiddenWidgetIds({ ccHidden: ['model', 'tokens'], ccHiddenEmpty: ['model'], isEmpty: true }))
      .toEqual(['model', 'tokens'])
    // 「再藏表是空数组」= 空态不再多藏任何件（但主管表那几件仍藏着）
    expect(resolveCcHiddenWidgetIds({ ccHidden: ['tokens'], ccHiddenEmpty: [], isEmpty: true }))
      .toEqual(['tokens'])
    // 穷举一遍：对任意两份表，空态生效名单恒为常态生效名单的超集
    const cases: Array<[string[], string[]]> = [
      [[], []], [['model'], []], [[], ['model']], [['model'], ['model']],
      [['model', 'tokens'], ['tokens']], [['tokens'], ['model', 'tokens']],
    ]
    for (const [ccHidden, ccHiddenEmpty] of cases) {
      const normal = resolveCcHiddenWidgetIds({ ccHidden, ccHiddenEmpty, isEmpty: false })
      const empty = resolveCcHiddenWidgetIds({ ccHidden, ccHiddenEmpty, isEmpty: true })
      for (const id of normal) {
        expect(empty, `主管表藏的 ${id} 在空态被放出来了（再藏表不该有"抵消"能力）`).toContain(id)
      }
    }
  })

  it('读侧不做"缺省回落"：给什么读什么（它是纯函数，只认传进来的值）', () => {
    // 两份表都空 ⇒ 两边都空（不报错、也不凭空长东西）
    expect(resolveCcHiddenWidgetIds({ ccHidden: [], ccHiddenEmpty: [], isEmpty: true })).toEqual([])
    expect(resolveCcHiddenWidgetIds({ ccHidden: [], ccHiddenEmpty: [], isEmpty: false })).toEqual([])
  })
})

// ★ #266 刀4：这里原先有一组「预设没写空态切面 ⇒ 落值时抄该预设的常态切面」的用例
//   （imports 的 `inheritCcEmptySlice` 及其 3 条行为断言：回落 / 显式空数组 / 纯函数）。
//   该机制（与函数本身）**已随刀4 删除** —— 结构 C 下读侧做并集，不再需要"缺省回落"：
//   预设没写"再藏" ⇒ 该键不进 patch ⇒ 由 `DEFAULTS.ccHiddenEmpty`（出厂那 6 件）当基准。
//   于是那几条用例**语义消失**（不是放宽），逐条移除。替换判据见下一条。
describe('#266 刀4 · 预设没写"再藏" ⇒ 退回 `DEFAULTS` 基准（不再抄常态表）', () => {
  const state = { ...structuredClone(DEFAULTS), customPresets: [] } as unknown as ThemePresetState

  it('★ 区域预设（cc）：只带主管表 ⇒ patch 里**不长出** `ccHiddenEmpty` 键（由 DEFAULTS 兜底 6 件）', () => {
    const patch = applyZonePresetReducer(state, 'cc', '只带主管表的区域预设', { ccHidden: ['model', 'tokens'] })
    expect(patch.ccHidden).toEqual(['model', 'tokens'])
    // ★ 反面：若这里变成 ['model','tokens']，说明"抄常态表"那条回落又回来了（C 明确取消它）
    expect(patch.ccHiddenEmpty, '不许再回落成常态表').toBeUndefined()
  })

  it('★ 写了就用写的：显式给一份再藏表 ⇒ 原样落 patch', () => {
    const written = applyZonePresetReducer(state, 'cc', '带再藏表的区域预设', { ccHidden: ['tokens'], ccHiddenEmpty: ['model'] })
    expect(written.ccHiddenEmpty).toEqual(['model'])
    // 显式空数组 = 该套不打算多藏任何件（仍是显式值，照用；它不等于"没写"）
    const explicitNone = applyZonePresetReducer(state, 'cc', '不再多藏的预设', { ccHidden: ['tokens'], ccHiddenEmpty: [] })
    expect(explicitNone.ccHiddenEmpty, '显式空数组必须保住（否则无法表达"这份不再多藏"）').toEqual([])
  })

  it('非 cc 区 ⇒ 不该凭空长出这两份表里的任何一份', () => {
    const otherZone = applyZonePresetReducer(state, 'chat', 'x', { chatBg: '#123456' })
    expect(otherZone.ccHiddenEmpty, '非 cc 区不该凭空长出再藏表').toBeUndefined()
    expect(otherZone.ccHidden, '非 cc 区不该凭空长出主管表').toBeUndefined()
  })
})
