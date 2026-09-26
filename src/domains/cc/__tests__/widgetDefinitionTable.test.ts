import { describe, expect, it } from 'vitest'
import {
  CC_FLOATING_WIDGET_IDS,
  CC_REGISTERED_SLOT_IDS,
  CC_SYSTEM_FIELDS,
  CC_WIDGET_GROUPS,
  CC_WIDGET_IDS,
  CC_WIDGET_LABELS,
  EMPTY_STATE_HIDDEN_WIDGET_IDS,
  STATUS_WIDGET_IDS,
  WIDGET_PROPERTY_FIELDS,
  ccInputLandingViolations,
  ccWidgetLanding,
  coerceInputLanding,
  isWidgetVisible,
  resolveCcHiddenWidgetIds,
  resolveCcWidgetGroup,
  type CcWidgetMember,
} from '../widgetDefinitions.ts'
import {
  BUILTIN_CC_SEND_BUTTON_CONTRIBUTION,
  BUILTIN_CC_SURFACE_CONTRIBUTION,
} from '../widgetCatalog.ts'
import {
  CC_LAYOUT_SCHEMA_VERSION,
  DEFAULT_CC_LAYOUT,
  type CcLayoutWidgetId,
} from '../ccLayoutState.ts'
import { resolveVisibleStatusWidgetCount } from '../ccHeightState.ts'
import { ZONE_FIELDS, CC_MEMBER_FIELDS, type ThemeFieldKey } from '../../../themeFieldDefs.ts'

/**
 * #238 刀1（结构步）不变量与零变化锁。
 *
 * 这一份测试是「表立错了」与「新行为错了」的分界：
 * - §1~§3 锁**表本身**（覆盖完整 / 无重叠 / 计数 / 锚点 / 成员不进名单）；
 * - §4 锁**派生结果**（名单、默认布局、标签、属性表单）；
 * - §5 锁**零变化**（默认布局逐条、中文名逐字、工具条 6 条、显隐集合的实际效果）。
 */
const ccFields = ZONE_FIELDS.cc
const memberRows = CC_WIDGET_GROUPS.flatMap(group =>
  group.members.map(member => ({ group, member })),
)
const slotIds: readonly string[] = [...CC_WIDGET_IDS, ...CC_REGISTERED_SLOT_IDS]

/**
 * ★ #238 刀6：定义表里那份手写的 `members[].fields` 已删（真值收敛到字段自己的 `group`）。
 * 成员名下有哪些字段，现在读**派生视图** `CC_MEMBER_FIELDS`（= 按 `def.group` 反查）。
 * ⇒ 下面这些断言的**价值不变**：literal 仍是独立的一份，写错 `def.group` 照样红。
 * ★ 注意顺序：派生列表 = 字段在 `themeFieldDefs.ts` 里的**定义顺序**（旧的手写顺序已随清单删除）。
 *   "谁拥有哪些字段"才是契约，谁的列表排在前面不是 —— 故那条逐条锁定的断言按**集合**比对。
 */
const fieldsOf = (member: CcWidgetMember): readonly ThemeFieldKey[] => CC_MEMBER_FIELDS[member.label] ?? []

/** 每个字段 → 拥有它的行（成员 id 或 'system'）。 */
function fieldOwners(): Map<string, string[]> {
  const owners = new Map<string, string[]>()
  const add = (field: string, owner: string) => {
    owners.set(field, [...(owners.get(field) ?? []), owner])
  }
  for (const { group, member } of memberRows) {
    for (const field of fieldsOf(member)) add(field, `${group.id}/${member.id}`)
  }
  for (const field of CC_SYSTEM_FIELDS) add(field, 'system')
  return owners
}

describe('#238 · 定义表不变量 1-2：字段覆盖完整、无重叠', () => {
  it('79 个 cc 字段每一个恰好有一个归属行，无遗漏', () => {
    const owners = fieldOwners()
    expect(ccFields).toHaveLength(79)
    expect([...owners.keys()].sort()).toEqual([...ccFields].sort())
  })

  it('同一字段不得出现在两个归属行里', () => {
    const duplicates = [...fieldOwners()].filter(([, owners]) => owners.length !== 1)
    expect(duplicates).toEqual([])
  })

  it('逐组字段计数（对账用；不等于这些数即表被改动）', () => {
    const counts = Object.fromEntries(CC_WIDGET_GROUPS.map(group => [
      group.id,
      group.members.reduce((sum, member) => sum + fieldsOf(member).length, 0),
    ]))
    expect(counts).toEqual({
      'cc-surface': 8,
      input: 33,
      model: 7,
      reasoning: 7,
      mode: 9,
      tokens: 2,
      'cc-command-hint': 2,
      'cc-send-button': 9,
    })
    // ★ #238 刀3：`footerLayout` 由系统桶转入容器行（归属转移，字段与实现不动）⇒ 系统桶 7 → 6
    // ★ #238 刀5：桶里三项（ccStatusFontSize / statusBg / statusBgImage）删除 ⇒ 6 → 3；
    //   命令行提示的字号 `ccHintFontSize` 由 `cc-command-hint` 成员自己认领（成员计数 1 → 2）。
    // ★ #238 刀7：`ccScale`（缩放）整体删除 ⇒ 系统桶 3 → 2；它原本就**不属于任何成员**（跨元件系统字段）。
    // ★ #238 刀8：`ccVariant`（整体风格）整体删除 ⇒ 容器行成员计数 9 → **8**（它属「中控本体面」成员）。
    expect(CC_SYSTEM_FIELDS).toHaveLength(2)
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0) + CC_SYSTEM_FIELDS.length
    expect(total).toBe(79)
  })

  it('成员字段必须落在 cc zone 内', () => {
    const outside = memberRows.flatMap(({ member }) => fieldsOf(member).filter(field => !ccFields.includes(field)))
    expect(outside).toEqual([])
  })

  it('成员 ↔ 字段的归属逐条锁定（挂到错的成员即红）', () => {
    // ★ #238 刀6：派生列表的顺序 = 字段在 `themeFieldDefs.ts` 里的定义顺序，与旧的手写顺序不同
    //   ⇒ 按**集合**比对。"谁拥有哪些字段"是契约；成员内部字段的呈现顺序由 `THEME_FIELD_KEYS` 决定。
    const asSet = (entries: Record<string, readonly string[]>) =>
      Object.fromEntries(Object.entries(entries).map(([member, keys]) => [member, [...keys].sort()]))
    const map = asSet(Object.fromEntries(memberRows.map(({ group, member }) => [`${group.id}/${member.id}`, fieldsOf(member)])))
    expect(map).toEqual(asSet({
      'cc-surface/surface-body': ['ccHeight', 'ccMarginX', 'ccMarginBottom', 'ccRadius', 'ccBg', 'ccSurfaceOpacity', 'ccBgImage', 'footerLayout'],
      'input/textarea': [
        'inputOffsetTop', 'inputHeight', 'inputMarginX',
        'inputSurfaceBg', 'inputSurfaceOpacity', 'inputFocusRingEnabled', 'inputFocusRingColor',
        'inputHighlightOpacity', 'inputShadowEnabled', 'inputBg', 'inputBgImage',
        'inputTextColor', 'inputPlaceholder', 'inputShowPlaceholder',
        'inputBorderColor', 'inputFocusBorder', 'inputBorder', 'inputBorderWidth', 'inputBorderOpacity',
        'inputRadius', 'inputFontSize', 'inputLineHeight', 'inputMinHeight',
        'inputMode', 'inputVariant', 'cliTextColor', 'cliContentOffsetY', 'cliOverflowMode',
      ],
      'input/cli-prefix': ['cliPromptColor'],
      'input/cli-lines': ['cliLineWidth', 'cliLineColor', 'cliLinePadding'],
      'input/command-palette': [],
      'input/history-hint': ['inputShowHistoryHint'],
      'input/prediction': [],
      'input/queue': [],
      'input/error': [],
      'input/empty-slot': [],
      'model/trigger': ['modelSwitchMode', 'modelBgColor', 'modelWidth', 'modelHeight', 'modelRadius', 'modelFontSize', 'modelTextColor'],
      'model/menu': [],
      'reasoning/trigger': ['reasoningSwitchMode', 'reasoningBgColor', 'reasoningWidth', 'reasoningHeight', 'reasoningRadius', 'reasoningFontSize', 'reasoningTextColor'],
      'reasoning/menu': [],
      'mode/trigger': [
        'permissionSwitchMode', 'permissionBgColor', 'permissionWidth', 'permissionHeight',
        'permissionRadius', 'permissionFontSize', 'permissionTextColor', 'modeAutoColor', 'modeEditColor',
      ],
      'mode/menu': [],
      'tokens/pill': ['pillText', 'prismOnColor'],
      'cc-command-hint/hint-line': ['cliHintMode', 'ccHintFontSize'],
      'cc-send-button/button': ['inputSubmitButtonMode', 'sendButtonColor', 'sendButtonRadius', 'sendButtonBorderColor', 'sendVariant'],
      'cc-send-button/icon': ['sendButtonIcon', 'sendButtonIconGenerating', 'sendButtonIconRound', 'sendButtonIconColor'],
    }))
  })

  it('成员显隐只是说明列：不承载"按字段判明"（四类子部件归入 always）', () => {
    // ★ 2026-09-23 口径：成员 `visibility` 是**说明**，不是门；类型上的 `field` 变体已删。
    //   这四类原先靠 `{kind:'field'}` 声明判明的子部件，现在一律声明常态可见 ——
    //   它们真正出不出现的判据在各渲染分支（inputVariant / inputShowHistoryHint）。
    const kindByLabel = new Map(memberRows.map(({ member }) => [member.label, member.visibility.kind]))
    for (const label of ['提示符 ❯', '上下两条线', '历史快捷提示', '提示行']) {
      expect(kindByLabel.get(label), `${label} 应声明为常态可见（判明门已撤）`).toBe('always')
    }
    // 反向确认没被"空手放过"：三类说明值都真实存在，且没有第四类冒出来
    expect([...new Set(memberRows.map(({ member }) => member.visibility.kind))].sort())
      .toEqual(['always', 'content', 'host'])
  })
})

describe('#238 · 定义表不变量 3：类型计数 7 控件 + 1 容器', () => {
  it('控件 7 + 容器 1 = 8，且与内置轨 ∪ 注册轨 ∪ {cc-command-hint} 逐条一致', () => {
    const widgets = CC_WIDGET_GROUPS.filter(row => row.type === 'widget').map(row => row.id)
    const containers = CC_WIDGET_GROUPS.filter(row => row.type === 'container').map(row => row.id)
    expect(CC_WIDGET_GROUPS).toHaveLength(8)
    expect(widgets).toHaveLength(7)
    expect(containers).toEqual(['cc-surface'])
    // ★ #238 刀5B：`cc-command-hint` 已升格 ⇒ 落进 CC_WIDGET_IDS，不必再单独并进来
    expect([...widgets].sort()).toEqual([...CC_WIDGET_IDS, ...CC_REGISTERED_SLOT_IDS].sort())
  })

  it('可拖行 = 落槽行（★ 刀5B：命令行提示已升格进来）；容器不可拖', () => {
    expect(slotIds).toEqual(['input', 'model', 'reasoning', 'mode', 'tokens', 'cc-command-hint', 'cc-send-button'])
    expect(resolveCcWidgetGroup('cc-command-hint')?.draggable).toBe(true)
    expect(resolveCcWidgetGroup('cc-surface')?.draggable).toBe(false)
  })
})

describe('#238 · 定义表不变量 4：成员与容器不进名单', () => {
  it('ccLayout / ccHidden 的取值名集合不含任何成员 id 与容器 id', () => {
    const layoutNames = slotIds
    expect(layoutNames).not.toContain('cc-surface')
    const leaked = memberRows
      .map(({ member }) => member.id)
      .filter(memberId => layoutNames.includes(memberId))
    expect(leaked).toEqual([])
    // 反向确认这份名单没被空手放过：它必须正好是默认布局的键集
    expect([...layoutNames].sort()).toEqual(Object.keys(DEFAULT_CC_LAYOUT.placements).sort())
  })

  it('成员 id 不得落进空态隐藏名单', () => {
    // ★ #266 ⑰：原来还有一份「常态放行名单」（`ALWAYS_VISIBLE_STATUS_WIDGET_IDS`）要求同一件事，
    //   该名单已随 ⑰ 删除 ⇒ 这条保护由**语境侧的空态名单**继续承担。
    const memberIds = memberRows.map(({ member }) => member.id)
    expect(memberIds.filter(id => (EMPTY_STATE_HIDDEN_WIDGET_IDS as readonly string[]).includes(id))).toEqual([])
  })
})

describe('#238 · 定义表不变量 5-6：容器唯一不参与排布、锚点无环', () => {
  it('恰有 1 个容器，它不参与排布、也不进工具条', () => {
    const containers = CC_WIDGET_GROUPS.filter(row => row.type === 'container')
    expect(containers).toHaveLength(1)
    expect(containers[0]!.id).toBe('cc-surface')
    expect(containers[0]!.layout).toBeUndefined()
    expect(Object.keys(DEFAULT_CC_LAYOUT.placements)).not.toContain('cc-surface')
    expect(slotIds).not.toContain('cc-surface')
  })

  it('两轴的锚点都指向表内存在的 id；顺 y 锚点走无环且终止于容器 cc-surface', () => {
    const allIds = CC_WIDGET_GROUPS.map(row => row.id)
    for (const row of CC_WIDGET_GROUPS) {
      if (!row.layout) continue
      expect(allIds).toContain(row.layout.x.anchor)
      expect(allIds).toContain(row.layout.y.anchor)
    }
    for (const row of CC_WIDGET_GROUPS) {
      const seen = new Set<string>([row.id])
      let cursor: string | undefined = row.layout?.y.anchor
      let terminal: string = row.id
      while (cursor !== undefined) {
        expect(seen.has(cursor)).toBe(false)
        seen.add(cursor)
        terminal = cursor
        cursor = resolveCcWidgetGroup(cursor)?.layout?.y.anchor
      }
      expect(terminal).toBe('cc-surface')
    }
    expect(resolveCcWidgetGroup('cc-surface')?.layout).toBeUndefined()
  })

  it('★ 只有输入栏能落在输入栏容器里（原「input 槽独占」规则的替代）', () => {
    // 槽位层拆掉后，元件落在哪个容器完全由表的 `(y.anchor, y.side)` 决定，
    // 拖拽只能改 offset/order、改不了归属 ⇒ 这条规则现在是**表级不变量**。
    const inputLanding = ccWidgetLanding('input')
    expect(inputLanding).toBe('cc-surface:top')
    const landedOnInput = CC_WIDGET_GROUPS
      .filter(row => row.layout && ccWidgetLanding(row.id) === inputLanding)
      .map(row => row.id)
    expect(landedOnInput).toEqual(['input'])
  })

  it('落脚处与悬浮声明：两个落点 + 恰一个悬浮件（发送按钮）', () => {
    expect(ccWidgetLanding('model')).toBe('cc-surface:bottom')
    expect(ccWidgetLanding('reasoning')).toBe('cc-surface:bottom')
    expect(ccWidgetLanding('cc-command-hint')).toBe('cc-surface:bottom')
    expect(ccWidgetLanding('cc-send-button')).toBe('input:center')
    expect(ccWidgetLanding('cc-surface')).toBeUndefined()
    expect(CC_FLOATING_WIDGET_IDS).toEqual(['cc-send-button'])
    // 悬浮件不进文档流成组 ⇒ 它不在任何信息落点的成员里
    expect(CC_WIDGET_GROUPS.filter(row => ccWidgetLanding(row.id) === 'cc-surface:bottom').map(row => row.id))
      .not.toContain('cc-send-button')
    // `align` 简写：两轴共用同一锚点
    const send = resolveCcWidgetGroup('cc-send-button')!.layout!
    expect(send.x.anchor).toBe('input')
    expect(send.y.anchor).toBe('input')
    expect(send.x.side).toBe('right')
    expect(send.y.side).toBe('center')
  })
})

describe('#238 · 派生结果一致（默认布局 / 名单 / 标签 / 属性表单）', () => {
  it('DEFAULT_CC_LAYOUT 由表派生（含键序 = 表序，契约快照按此序落盘）', () => {
    expect(CC_LAYOUT_SCHEMA_VERSION).toBe(9)
    expect(Object.keys(DEFAULT_CC_LAYOUT.placements)).toEqual([
      'input', 'model', 'reasoning', 'mode', 'tokens', 'cc-command-hint', 'cc-send-button',
    ])
    // ★ #238 刀3：`slot` 退场；序号语义由「槽内序号」变为「同落脚处组内序号」。
    // ★ #266 遗留⑦：序号改为**连续值 1..6**（按当前实际显示顺序）。原先是 0/2/3/4/5，
    //   且「命令行提示」与「用量」撞在同一个 5 上 ⇒ 同落脚处内的先后只能靠表序兜着。
    //   ★ 定义表与出厂区域预设的落盘数据（`zones/factory/**`）两处必须一致，
    //   一致性由 `src/zones/__tests__/factoryZonePresetLayoutGuard.test.ts` 机检（数据 ↔ 定义表）。
    expect(DEFAULT_CC_LAYOUT).toEqual({
      version: 9,
      placements: {
        input: { order: 1, offsetX: 0, offsetY: 0 },
        model: { order: 2, offsetX: 0, offsetY: 0 },
        reasoning: { order: 3, offsetX: 0, offsetY: 0 },
        mode: { order: 4, offsetX: 0, offsetY: 0 },
        tokens: { order: 5, offsetX: 0, offsetY: 0 },
        // ★ #266 遗留⑦：提示的序号 = 6（原先沿用结构步时的 5，与 tokens 撞号）
        'cc-command-hint': { order: 6, offsetX: 0, offsetY: 0 },
        // 悬浮件（发送按钮）自己一个落脚处，序号仍是 0
        'cc-send-button': { order: 0, offsetX: 0, offsetY: 0 },
      },
    })
  })

  it('默认布局逐条 = 表里同 id 的 layout.order（+ 默认零偏移）', () => {
    for (const row of CC_WIDGET_GROUPS) {
      if (!row.draggable || !row.layout) continue
      expect(DEFAULT_CC_LAYOUT.placements[row.id as CcLayoutWidgetId], row.id)
        .toEqual({ order: row.layout.order, offsetX: 0, offsetY: 0 })
    }
  })

  it('内置轨 / 注册轨名单 = 表里对应轨道的可拖行（顺序 = 表序）', () => {
    expect(CC_WIDGET_IDS).toEqual(['input', 'model', 'reasoning', 'mode', 'tokens', 'cc-command-hint'])
    expect(CC_REGISTERED_SLOT_IDS).toEqual(['cc-send-button'])
    expect(STATUS_WIDGET_IDS).toEqual(['model', 'reasoning', 'mode', 'tokens', 'cc-command-hint'])
  })

  it('★ 编辑工具条 6 → 7 条（内置轨 6 + 注册轨 1），cc-surface 不进', () => {
    // ★ #238 刀5B 两处预期变化之一：提示升格后自动进工具条。
    expect(slotIds).toHaveLength(7)
  })

  it('空态隐藏 6 条（⑰ 起含命令行提示）——它是**语境侧名单**，与预设的值无关', () => {
    // ★ #266 ⑰：名单由行上派生改为**字面量**；`cc-command-hint` 是 ⑰ 新加入的一条 ——
    //   空态没有会话，命令行提示没有意义（原由行上 `conditions` 的 `'has-session'` 承担）。
    expect([...EMPTY_STATE_HIDDEN_WIDGET_IDS].sort())
      .toEqual(['cc-send-button', 'cc-command-hint', 'model', 'reasoning', 'mode', 'tokens'].sort())
    expect(EMPTY_STATE_HIDDEN_WIDGET_IDS).toContain('cc-send-button')
  })

  it('标签表逐字不变（含容器与不可拖行）', () => {
    expect(CC_WIDGET_LABELS).toEqual({
      'cc-surface': '中控本体背景板',
      input: '输入栏',
      model: '模型',
      reasoning: '思考强度',
      mode: '权限模式',
      tokens: '用量',
      'cc-command-hint': '命令行提示',
      'cc-send-button': '发送按钮',
    })
  })

  it('目录三份（名字 / 类别 / 位置）直接读表后内容不变', () => {
    // ★ #238 第③件：旧目录视图 `BUILTIN_CC_WIDGET_DEFINITIONS` 已删（生产侧零消费者）。
    //   这三条原本锁的是「表派生出来的目录内容」；**简单删掉等于白丢一层保护**
    //   ⇒ 改成**直接读表**：名字 / 类别 / 位置的真值本来就在表里，去掉目录这层中转后
    //   断言的仍然是同一批值（`offsetX/offsetY` 是插件契约形状里的固定 0，一并锁住）。
    const rows = CC_WIDGET_IDS.map(id => resolveCcWidgetGroup(id)!)
    expect(rows.map(row => [row.id, row.label, row.category])).toEqual([
      ['input', '输入栏', 'input'],
      ['model', '模型', 'runtime'],
      ['reasoning', '思考强度', 'runtime'],
      ['mode', '权限模式', 'runtime'],
      ['tokens', '用量', 'context'],
      // ★ 刀5B：提示升格 ⇒ 目录（由表派生）多一条
      ['cc-command-hint', '命令行提示', 'input'],
    ])
    expect(rows.map(row => ({
      anchor: row.layout!.x.anchor,
      side: row.layout!.x.side,
      order: row.layout!.order,
      offsetX: 0,
      offsetY: 0,
    }))).toEqual([
      { anchor: 'cc-surface', side: 'stretch', order: 1, offsetX: 0, offsetY: 0 },
      { anchor: 'cc-surface', side: 'left', order: 2, offsetX: 0, offsetY: 0 },
      { anchor: 'cc-surface', side: 'left', order: 3, offsetX: 0, offsetY: 0 },
      { anchor: 'cc-surface', side: 'left', order: 4, offsetX: 0, offsetY: 0 },
      { anchor: 'cc-surface', side: 'left', order: 5, offsetX: 0, offsetY: 0 },
      { anchor: 'cc-surface', side: 'left', order: 6, offsetX: 0, offsetY: 0 },
    ])
    // 用量控件不新增属性字段（S11 拍板）⇒ 表里它的属性表单为空
    expect(WIDGET_PROPERTY_FIELDS.tokens).toEqual([])
    expect(BUILTIN_CC_SURFACE_CONTRIBUTION.label).toBe('中控本体背景板')
    expect(BUILTIN_CC_SURFACE_CONTRIBUTION.defaultPlacement).toBeUndefined()
    expect(BUILTIN_CC_SEND_BUTTON_CONTRIBUTION.label).toBe('发送按钮')
    // ★ #238 刀3：插件契约的 `slot` 换成 `anchor` + 可选 `side`
    expect(BUILTIN_CC_SEND_BUTTON_CONTRIBUTION.defaultPlacement).toEqual({ anchor: 'input', side: 'right', order: 0, offsetX: 0, offsetY: 0 })
  })
})

describe('#238 · 零变化：属性面板的字段集与顺序', () => {
  it('每个控件的属性表单字段集与顺序逐条不变', () => {
    const strip = (id: string) => WIDGET_PROPERTY_FIELDS[id as keyof typeof WIDGET_PROPERTY_FIELDS]
      .map(field => field.kind === 'section' ? `section:${field.title}` : `${field.kind}:${field.key}`)
    expect(strip('input')).toEqual([
      'section:输入栏设置', 'color:inputBg', 'color:inputTextColor',
      'number:inputFontSize', 'number:inputMinHeight', 'chips:inputMode',
      'number:cliLineWidth', 'color:cliLineColor', 'number:cliLinePadding',
    ])
    expect(strip('model')).toEqual([
      'section:模型控件', 'chips:modelSwitchMode', 'color:modelBgColor',
      'number:modelWidth', 'number:modelHeight', 'number:modelRadius',
      'number:modelFontSize', 'color:modelTextColor',
    ])
    expect(strip('reasoning')).toEqual([
      'section:思考强度控件', 'chips:reasoningSwitchMode', 'color:reasoningBgColor',
      'number:reasoningWidth', 'number:reasoningHeight', 'number:reasoningRadius',
      'number:reasoningFontSize', 'color:reasoningTextColor',
    ])
    expect(strip('mode')).toEqual([
      'section:权限控件', 'chips:permissionSwitchMode', 'color:permissionBgColor',
      'number:permissionWidth', 'number:permissionHeight', 'number:permissionRadius',
      'number:permissionFontSize', 'color:permissionTextColor',
    ])
    expect(strip('tokens')).toEqual([])
  })

  it('命令行边框三项不再带 showIf（两模式常态显示）', () => {
    // ★ 2026-09-23 用户口径：「不要这个判明条件，常态显示，预设里我手动改」
    //   ⇒ 原三条 `showIf: t => t.inputMode === 'cli'` 删除。这条断言的**靶子反了过来**：
    //   原先锁"仍带 showIf"，现在锁"还在表里、且一个条件都没有"。
    const fields = WIDGET_PROPERTY_FIELDS.input.filter(field => field.kind !== 'section')
    for (const key of ['cliLineWidth', 'cliLineColor', 'cliLinePadding'] as const) {
      const field = fields.find(candidate => candidate.key === key)
      expect(field, `${key} 不该从属性表单里消失（撤条件 ≠ 删项）`).toBeDefined()
      expect(field && 'showIf' in field ? field.showIf : undefined, `${key} 不该再带条件显示`).toBeUndefined()
    }
    // 全表零 showIf：这条路已撤，防回摆（有人再挂一条即红）
    const withShowIf = Object.values(WIDGET_PROPERTY_FIELDS)
      .flat()
      .filter(field => field.kind !== 'section' && field.showIf)
    expect(withShowIf).toEqual([])
  })

  it('属性表单指向的字段必须由本组的某个成员拥有（挂错成员即红）', () => {
    const violations: string[] = []
    for (const group of CC_WIDGET_GROUPS) {
      const owned = new Set(group.members.flatMap(member => fieldsOf(member)))
      for (const field of group.propertyFields ?? []) {
        if (field.kind === 'section') continue
        if (!owned.has(field.key)) violations.push(`${group.id}: ${field.key}`)
        if (field.kind === 'chips') {
          for (const option of field.options) {
            if (option.sync && !owned.has(option.sync.key)) violations.push(`${group.id}: sync ${option.sync.key}`)
          }
        }
      }
    }
    expect(violations).toEqual([])
  })
})

describe('#238 刀3 · 输入栏落脚处独占守卫（原「input 槽只准放输入栏」的替代）', () => {
  it('表自身零违规', () => {
    expect(ccInputLandingViolations(CC_WIDGET_GROUPS.map(row => row.id))).toEqual([])
  })

  it('非输入栏被错标到输入栏落脚处 ⇒ 退回信息落脚处（宁可换位置，不凭空消失）', () => {
    expect(coerceInputLanding('input', 'cc-surface:top')).toBe('cc-surface:top')
    expect(coerceInputLanding('model', 'cc-surface:top')).toBe('cc-surface:bottom')
    expect(coerceInputLanding('mode', 'cc-surface:top')).toBe('cc-surface:bottom')
    expect(coerceInputLanding('model', 'cc-surface:bottom')).toBe('cc-surface:bottom')
    // 悬浮件（发送按钮）不在文档流落脚处这套规则里，原样返回
    expect(coerceInputLanding('cc-send-button', 'input:center')).toBe('input:center')
  })
})

describe('#266 ⑰ · 可见性只剩「值 + 语境名单」（元件不自己申明）', () => {
  it('行上不再有任何显隐申明（对象层：三个键都不存在）', () => {
    // ★ 用户口径：「如果要记『这里不显示』，应该是在这里注明 a 不显示，而不是 a 申明在这里不显示」
    //   ⇒ 原先的三样（`inActiveSession` / `conditions` / `hiddenInEmptyState`）从行上撤掉。
    for (const row of CC_WIDGET_GROUPS) {
      for (const key of ['inActiveSession', 'conditions', 'hiddenInEmptyState']) {
        expect(Object.hasOwn(row, key), `${row.id} 不该再有 ${key}`).toBe(false)
      }
    }
    // 正控：表本体仍在（否则上面的断言会因为"表整个没了"而假绿）
    expect(CC_WIDGET_GROUPS).toHaveLength(8)
  })

  it('命令行提示：没有会话 / 标准输入模式下**照样可见**（本件的目的）', () => {
    // ★ 反转自旧断言 `inputMode: 'default' ⇒ false`：用户口径「命令行提示按模式驱动可见我后悔了」。
    expect(isWidgetVisible('cc-command-hint', { hidden: [] })).toBe(true)
    expect(isWidgetVisible('cc-command-hint', { hidden: [], editMode: true })).toBe(true)
  })

  it('`ccHidden` 仍能藏它；编辑态豁免（把藏起来的元件露出来）', () => {
    expect(isWidgetVisible('cc-command-hint', { hidden: ['cc-command-hint'] })).toBe(false)
    expect(isWidgetVisible('cc-command-hint', { hidden: ['cc-command-hint'], editMode: true })).toBe(true)
  })

  it('详细档「隐藏」按**值**折进名单（组装只有一处，渲染与计数同源）', () => {
    expect(resolveCcHiddenWidgetIds({ ccHidden: [], cliHintMode: 'compact' })).toEqual([])
    expect(resolveCcHiddenWidgetIds({ ccHidden: [], cliHintMode: 'full' })).toEqual([])
    expect(resolveCcHiddenWidgetIds({ ccHidden: [], cliHintMode: 'hidden' })).toEqual(['cc-command-hint'])
    // 已在名单里不重复追加（集合语义）
    expect(resolveCcHiddenWidgetIds({ ccHidden: ['cc-command-hint'], cliHintMode: 'hidden' })).toEqual(['cc-command-hint'])
    // 折进名单后由同一个谓词判隐 —— 谓词里不再需要"详细档"这件事
    expect(isWidgetVisible('cc-command-hint', {
      hidden: resolveCcHiddenWidgetIds({ ccHidden: [], cliHintMode: 'hidden' }),
    })).toBe(false)
    // 预设里用户自己藏的那些原样带出（不吞不改）
    expect(resolveCcHiddenWidgetIds({ ccHidden: ['model'], cliHintMode: 'compact' })).toEqual(['model'])
  })

  it('空态由**语境侧名单**承担：提示在内 ⇒ 空态不显示（原由 `has-session` 条件承担）', () => {
    const emptyHidden = resolveCcHiddenWidgetIds({
      ccHidden: [...EMPTY_STATE_HIDDEN_WIDGET_IDS],
      cliHintMode: 'full',
    })
    expect(EMPTY_STATE_HIDDEN_WIDGET_IDS).toContain('cc-command-hint')   // 反转自旧断言"不在内"
    expect(emptyHidden).toContain('cc-command-hint')
    expect(isWidgetVisible('cc-command-hint', { hidden: emptyHidden })).toBe(false)
  })

  it('计数与谓词同源：可见数 = 状态控件里不在名单上的个数', () => {
    const counts = (hiddenIds: readonly string[]) => resolveVisibleStatusWidgetCount({ hiddenIds })
    expect(counts(resolveCcHiddenWidgetIds({ ccHidden: [], cliHintMode: 'full' }))).toBe(5)     // 四常态 + 提示
    expect(counts(resolveCcHiddenWidgetIds({ ccHidden: [], cliHintMode: 'hidden' }))).toBe(4)   // 详细档隐藏 ⇒ 少提示
    // 空态：语境侧名单把 5 条状态控件全挡掉 ⇒ 计数 0（空态数值不变的成因）
    expect(counts(resolveCcHiddenWidgetIds({ ccHidden: [...EMPTY_STATE_HIDDEN_WIDGET_IDS], cliHintMode: 'full' }))).toBe(0)
  })
})

describe('#238 刀5B · 命令行提示已升格为可拖元件', () => {
  it('它在名单、默认布局里；空态名单里也有它（⑰ 起由语境侧名单接住）', () => {
    const hint = resolveCcWidgetGroup('cc-command-hint')
    expect(hint).toBeDefined()
    expect(hint?.draggable).toBe(true)
    expect(hint?.layout).toBeDefined()
    expect(Object.keys(DEFAULT_CC_LAYOUT.placements)).toContain('cc-command-hint')
    expect(slotIds).toContain('cc-command-hint')
    // ★ #266 ⑰：原先靠行上 `conditions` 的 `'has-session'` 把空态挡掉；撤条件后改由**空态名单**接住
    expect(EMPTY_STATE_HIDDEN_WIDGET_IDS).toContain('cc-command-hint')
  })

  it('它既受占区约束、也当障碍（不是悬浮件）', () => {
    expect(CC_FLOATING_WIDGET_IDS).not.toContain('cc-command-hint')
  })
})
