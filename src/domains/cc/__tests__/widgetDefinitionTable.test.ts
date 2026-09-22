import { describe, expect, it } from 'vitest'
import {
  ALWAYS_VISIBLE_STATUS_WIDGET_IDS,
  CC_REGISTERED_SLOT_IDS,
  CC_SYSTEM_FIELDS,
  CC_WIDGET_GROUPS,
  CC_WIDGET_IDS,
  CC_WIDGET_LABELS,
  EMPTY_STATE_HIDDEN_WIDGET_IDS,
  STATUS_WIDGET_IDS,
  WIDGET_PROPERTY_FIELDS,
  resolveCcWidgetGroup,
  type CcMemberVisibility,
} from '../widgetDefinitions.ts'
import {
  BUILTIN_CC_SEND_BUTTON_CONTRIBUTION,
  BUILTIN_CC_SURFACE_CONTRIBUTION,
  BUILTIN_CC_WIDGET_DEFINITIONS,
} from '../widgetCatalog.ts'
import {
  CC_LAYOUT_SCHEMA_VERSION,
  DEFAULT_CC_LAYOUT,
  type CcLayoutWidgetId,
} from '../../../ccLayoutState.ts'
import { ZONE_FIELDS } from '../../../themeFieldDefs.ts'

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

/** 每个字段 → 拥有它的行（成员 id 或 'system'）。 */
function fieldOwners(): Map<string, string[]> {
  const owners = new Map<string, string[]>()
  const add = (field: string, owner: string) => {
    owners.set(field, [...(owners.get(field) ?? []), owner])
  }
  for (const { group, member } of memberRows) {
    for (const field of member.fields) add(field, `${group.id}/${member.id}`)
  }
  for (const field of CC_SYSTEM_FIELDS) add(field, 'system')
  return owners
}

describe('#238 · 定义表不变量 1-2：字段覆盖完整、无重叠', () => {
  it('83 个 cc 字段每一个恰好有一个归属行，无遗漏', () => {
    const owners = fieldOwners()
    expect(ccFields).toHaveLength(83)
    expect([...owners.keys()].sort()).toEqual([...ccFields].sort())
  })

  it('同一字段不得出现在两个归属行里', () => {
    const duplicates = [...fieldOwners()].filter(([, owners]) => owners.length !== 1)
    expect(duplicates).toEqual([])
  })

  it('逐组字段计数（对账用；不等于这些数即表被改动）', () => {
    const counts = Object.fromEntries(CC_WIDGET_GROUPS.map(group => [
      group.id,
      group.members.reduce((sum, member) => sum + member.fields.length, 0),
    ]))
    expect(counts).toEqual({
      'cc-surface': 8,
      input: 33,
      model: 7,
      reasoning: 7,
      mode: 9,
      tokens: 2,
      'cc-command-hint': 1,
      'cc-send-button': 9,
    })
    expect(CC_SYSTEM_FIELDS).toHaveLength(7)
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0) + CC_SYSTEM_FIELDS.length
    expect(total).toBe(83)
  })

  it('成员字段必须落在 cc zone 内', () => {
    const outside = memberRows.flatMap(({ member }) => member.fields.filter(field => !ccFields.includes(field)))
    expect(outside).toEqual([])
  })

  it('成员 ↔ 字段的归属逐条锁定（挂到错的成员即红）', () => {
    const map = Object.fromEntries(memberRows.map(({ group, member }) => [`${group.id}/${member.id}`, member.fields]))
    expect(map).toEqual({
      'cc-surface/surface-body': ['ccHeight', 'ccMarginX', 'ccMarginBottom', 'ccRadius', 'ccBg', 'ccSurfaceOpacity', 'ccBgImage', 'ccVariant'],
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
      'cc-command-hint/hint-line': ['cliHintMode'],
      'cc-send-button/button': ['inputSubmitButtonMode', 'sendButtonColor', 'sendButtonRadius', 'sendButtonBorderColor', 'sendVariant'],
      'cc-send-button/icon': ['sendButtonIcon', 'sendButtonIconGenerating', 'sendButtonIconRound', 'sendButtonIconColor'],
    })
  })

  it('成员的默认显隐只引用已有字段', () => {
    type FieldRef = Extract<CcMemberVisibility, { kind: 'field' }>
    const refs = memberRows
      .map(({ member }) => member.visibility)
      .filter((visibility): visibility is FieldRef => visibility.kind === 'field')
    expect(refs.length).toBeGreaterThan(0)
    expect(refs.filter(ref => !ccFields.includes(ref.field))).toEqual([])
  })
})

describe('#238 · 定义表不变量 3：类型计数 7 控件 + 1 容器', () => {
  it('控件 7 + 容器 1 = 8，且与内置轨 ∪ 注册轨 ∪ {cc-command-hint} 逐条一致', () => {
    const widgets = CC_WIDGET_GROUPS.filter(row => row.type === 'widget').map(row => row.id)
    const containers = CC_WIDGET_GROUPS.filter(row => row.type === 'container').map(row => row.id)
    expect(CC_WIDGET_GROUPS).toHaveLength(8)
    expect(widgets).toHaveLength(7)
    expect(containers).toEqual(['cc-surface'])
    expect([...widgets].sort()).toEqual([...CC_WIDGET_IDS, ...CC_REGISTERED_SLOT_IDS, 'cc-command-hint'].sort())
  })

  it('可拖行 = 落槽行；命令行提示结构步不可拖', () => {
    expect(slotIds).toEqual(['input', 'model', 'reasoning', 'mode', 'tokens', 'cc-send-button'])
    expect(resolveCcWidgetGroup('cc-command-hint')?.draggable).toBe(false)
    expect(resolveCcWidgetGroup('cc-surface')?.draggable).toBe(false)
  })
})

describe('#238 · 定义表不变量 4：成员与容器不进三份名单', () => {
  it('ccLayout / ccHidden / ccScale 的取值名集合不含任何成员 id 与容器 id', () => {
    const layoutNames = slotIds
    expect(layoutNames).not.toContain('cc-surface')
    const leaked = memberRows
      .map(({ member }) => member.id)
      .filter(memberId => layoutNames.includes(memberId))
    expect(leaked).toEqual([])
    // 反向确认这份名单没被空手放过：它必须正好是默认布局的键集
    expect([...layoutNames].sort()).toEqual(Object.keys(DEFAULT_CC_LAYOUT.placements).sort())
  })

  it('成员 id 不得落进常态放行 / 空态隐藏这两份名单', () => {
    const memberIds = memberRows.map(({ member }) => member.id)
    expect(memberIds.filter(id => (EMPTY_STATE_HIDDEN_WIDGET_IDS as readonly string[]).includes(id))).toEqual([])
    expect(memberIds.filter(id => (ALWAYS_VISIBLE_STATUS_WIDGET_IDS as readonly string[]).includes(id))).toEqual([])
  })
})

describe('#238 · 定义表不变量 5-6：容器唯一不占位、锚点无环', () => {
  it('恰有 1 个容器，它不占任何位置、也不进工具条', () => {
    const containers = CC_WIDGET_GROUPS.filter(row => row.type === 'container')
    expect(containers).toHaveLength(1)
    expect(containers[0]!.id).toBe('cc-surface')
    expect(containers[0]!.defaultPlacement).toBeUndefined()
    expect(Object.keys(DEFAULT_CC_LAYOUT.placements)).not.toContain('cc-surface')
    expect(slotIds).not.toContain('cc-surface')
  })

  it('每个锚点指向表内存在的 id；顺锚点走无环且终止于容器 cc-surface', () => {
    const allIds = CC_WIDGET_GROUPS.map(row => row.id)
    for (const row of CC_WIDGET_GROUPS) {
      if (row.anchor === undefined) continue
      expect(allIds).toContain(row.anchor)
    }
    for (const row of CC_WIDGET_GROUPS) {
      const seen = new Set<string>([row.id])
      let cursor: string | undefined = row.anchor
      let terminal: string = row.id
      while (cursor !== undefined) {
        expect(seen.has(cursor)).toBe(false)
        seen.add(cursor)
        terminal = cursor
        cursor = resolveCcWidgetGroup(cursor)?.anchor
      }
      expect(terminal).toBe('cc-surface')
    }
    expect(resolveCcWidgetGroup('cc-surface')?.anchor).toBeUndefined()
  })
})

describe('#238 · 派生结果一致（默认布局 / 名单 / 标签 / 属性表单）', () => {
  it('DEFAULT_CC_LAYOUT 由表派生且值逐条不变（含键序，契约快照按此序落盘）', () => {
    expect(CC_LAYOUT_SCHEMA_VERSION).toBe(9)
    expect(Object.keys(DEFAULT_CC_LAYOUT.placements)).toEqual([
      'input', 'model', 'reasoning', 'mode', 'tokens', 'cc-send-button',
    ])
    expect(DEFAULT_CC_LAYOUT).toEqual({
      version: 9,
      placements: {
        input: { slot: 'input', order: 0, offsetX: 0, offsetY: 0 },
        model: { slot: 'status-secondary', order: 2, offsetX: 0, offsetY: 0 },
        reasoning: { slot: 'status-secondary', order: 3, offsetX: 0, offsetY: 0 },
        mode: { slot: 'status-secondary', order: 4, offsetX: 0, offsetY: 0 },
        tokens: { slot: 'status-secondary', order: 5, offsetX: 0, offsetY: 0 },
        'cc-send-button': { slot: 'actions', order: 0, offsetX: 0, offsetY: 0 },
      },
    })
  })

  it('默认布局逐条 = 表里同 id 的 defaultPlacement', () => {
    for (const row of CC_WIDGET_GROUPS) {
      if (!row.defaultPlacement) continue
      expect(DEFAULT_CC_LAYOUT.placements[row.id as CcLayoutWidgetId]).toEqual(row.defaultPlacement)
    }
  })

  it('内置轨 / 注册轨名单 = 表里对应轨道的可拖行（顺序 = 表序）', () => {
    expect(CC_WIDGET_IDS).toEqual(['input', 'model', 'reasoning', 'mode', 'tokens'])
    expect(CC_REGISTERED_SLOT_IDS).toEqual(['cc-send-button'])
    expect(STATUS_WIDGET_IDS).toEqual(['model', 'reasoning', 'mode', 'tokens'])
  })

  it('编辑工具条仍是 6 条（内置轨 5 + 注册轨 1），cc-surface 不进', () => {
    expect(slotIds).toHaveLength(6)
  })

  it('常态放行 / 空态隐藏的实际效果不变（成员集合一致）', () => {
    expect(ALWAYS_VISIBLE_STATUS_WIDGET_IDS).toEqual(['model', 'reasoning', 'mode', 'tokens'])
    expect([...EMPTY_STATE_HIDDEN_WIDGET_IDS].sort())
      .toEqual(['cc-send-button', 'model', 'reasoning', 'mode', 'tokens'].sort())
    // 两个集合语义不同，不许并成一个：空态隐藏比常态放行多出注册轨的发送按钮
    expect(EMPTY_STATE_HIDDEN_WIDGET_IDS).toContain('cc-send-button')
    expect(ALWAYS_VISIBLE_STATUS_WIDGET_IDS as readonly string[]).not.toContain('cc-send-button')
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

  it('目录三份（名字 / 类别 / 位置）由表派生后内容不变', () => {
    expect(BUILTIN_CC_WIDGET_DEFINITIONS.map(entry => [entry.id, entry.label, entry.category])).toEqual([
      ['input', '输入栏', 'input'],
      ['model', '模型', 'runtime'],
      ['reasoning', '思考强度', 'runtime'],
      ['mode', '权限模式', 'runtime'],
      ['tokens', '用量', 'context'],
    ])
    expect(BUILTIN_CC_WIDGET_DEFINITIONS.map(entry => entry.defaultPlacement)).toEqual([
      { slot: 'input', order: 0, offsetX: 0, offsetY: 0 },
      { slot: 'status-secondary', order: 2, offsetX: 0, offsetY: 0 },
      { slot: 'status-secondary', order: 3, offsetX: 0, offsetY: 0 },
      { slot: 'status-secondary', order: 4, offsetX: 0, offsetY: 0 },
      { slot: 'status-secondary', order: 5, offsetX: 0, offsetY: 0 },
    ])
    // 用量控件不新增属性字段（S11 拍板）⇒ 目录里不带 propertyFields
    expect(BUILTIN_CC_WIDGET_DEFINITIONS.find(entry => entry.id === 'tokens')?.propertyFields).toBeUndefined()
    expect(BUILTIN_CC_SURFACE_CONTRIBUTION.label).toBe('中控本体背景板')
    expect(BUILTIN_CC_SURFACE_CONTRIBUTION.defaultPlacement).toBeUndefined()
    expect(BUILTIN_CC_SEND_BUTTON_CONTRIBUTION.label).toBe('发送按钮')
    expect(BUILTIN_CC_SEND_BUTTON_CONTRIBUTION.defaultPlacement).toEqual({ slot: 'actions', order: 0, offsetX: 0, offsetY: 0 })
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
      'section:模型控件', 'chips:modelSwitchMode', 'chips:modelBgColor',
      'number:modelWidth', 'number:modelHeight', 'number:modelRadius',
      'number:modelFontSize', 'chips:modelTextColor',
    ])
    expect(strip('reasoning')).toEqual([
      'section:思考强度控件', 'chips:reasoningSwitchMode', 'chips:reasoningBgColor',
      'number:reasoningWidth', 'number:reasoningHeight', 'number:reasoningRadius',
      'number:reasoningFontSize', 'chips:reasoningTextColor',
    ])
    expect(strip('mode')).toEqual([
      'section:权限控件', 'chips:permissionSwitchMode', 'chips:permissionBgColor',
      'number:permissionWidth', 'number:permissionHeight', 'number:permissionRadius',
      'number:permissionFontSize', 'chips:permissionTextColor',
    ])
    expect(strip('tokens')).toEqual([])
  })

  it('cli 三个字段仍带 showIf（面板在非命令行模式仍按旧规则隐藏）', () => {
    const fields = WIDGET_PROPERTY_FIELDS.input.filter(field => field.kind !== 'section' && 'showIf' in field && field.showIf)
    expect(fields.map(field => field.kind === 'section' ? '' : field.key)).toEqual(['cliLineWidth', 'cliLineColor', 'cliLinePadding'])
    for (const field of fields) {
      expect(field.kind !== 'section' && field.showIf!({ inputMode: 'cli' })).toBe(true)
      expect(field.kind !== 'section' && field.showIf!({ inputMode: 'default' })).toBe(false)
    }
  })

  it('属性表单指向的字段必须由本组的某个成员拥有（挂错成员即红）', () => {
    const violations: string[] = []
    for (const group of CC_WIDGET_GROUPS) {
      const owned = new Set(group.members.flatMap(member => member.fields))
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

describe('#238 · 表尾：命令行提示结构步只进表、不归位', () => {
  it('命令行提示在表里但不在任何名单，且不占槽位', () => {
    const hint = resolveCcWidgetGroup('cc-command-hint')
    expect(hint).toBeDefined()
    expect(hint?.defaultPlacement).toBeUndefined()
    expect(slotIds).not.toContain('cc-command-hint')
    expect(ALWAYS_VISIBLE_STATUS_WIDGET_IDS as readonly string[]).not.toContain('cc-command-hint')
    expect(EMPTY_STATE_HIDDEN_WIDGET_IDS).not.toContain('cc-command-hint')
  })
})
