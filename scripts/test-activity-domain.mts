import { strict as assert } from 'node:assert'
import { resolveActivityLine, FALLBACK_ACTIVITY_VERBS } from '../src/domains/activity/activityLine.ts'
import { resolveTaskPill } from '../src/domains/activity/taskPill.ts'

// P1-02：activityLine 覆盖链（D5）+ tool stall 抑制（D29）+ thinking 时长（D30）+ taskPill 显隐

// 1. 覆盖链优先级：plan activeTask.content 最高
{
  const line = resolveActivityLine({ activeTaskContent: '重构状态机', phase: 'tool', toolTitle: 'Grep' })
  assert.equal(line.verb, '正在')
  assert.equal(line.activity, '正在重构状态机 …')
  assert.equal(line.stallSuppressed, undefined, 'plan 分支不携带 stall 抑制')
}

// 2. tool 阶段：stallSuppressed + title 文案；无 title 有兜底文案
{
  const line = resolveActivityLine({ phase: 'tool', toolTitle: 'Grep' })
  assert.equal(line.activity, '正在调用 Grep …')
  assert.equal(line.stallSuppressed, true, 'tool 阶段必须抑制 stall（D29）')
  assert.equal(resolveActivityLine({ phase: 'tool' }).activity, '正在调用工具 …')
}

// 3. thinking：durationMs 由 thinkingStart→now 推导（注入 now 确定性）
{
  const line = resolveActivityLine({ phase: 'thinking', thinkingStart: 1000, now: 5000 })
  assert.equal(line.verb, '思考中')
  assert.equal(line.durationMs, 4000)
  // 无 thinkingStart：无 duration
  assert.equal(resolveActivityLine({ phase: 'thinking' }).durationMs, undefined)
  // now 早于 thinkingStart（时钟回拨）→ 0 兜底
  assert.equal(resolveActivityLine({ phase: 'thinking', thinkingStart: 5000, now: 1000 }).durationMs, 0)
}

// 4. responding / 随机回退
{
  assert.equal(resolveActivityLine({ phase: 'responding' }).activity, '正在回复 …')
  const random = resolveActivityLine({})
  assert.equal(random.activity, `${random.verb} …`)
  // fallbackVerb 注入确定性
  const fixed = resolveActivityLine({ fallbackVerb: '思考中' })
  assert.equal(fixed.activity, '思考中 …')
  // FALLBACK_ACTIVITY_VERBS 非空
  assert.ok(FALLBACK_ACTIVITY_VERBS.length > 0)
}

// 5. 空 plan 回退到随机（activeTaskContent 缺省）
{
  const line = resolveActivityLine({ fallbackVerb: '整理思路' })
  assert.equal(line.activity, '整理思路 …')
  assert.equal(line.stallSuppressed, undefined)
}

// 6. taskPill：无任务不渲染；有任务显示「⇅ N 任务」+ 完成进度
{
  assert.deepEqual(resolveTaskPill([]), { visible: false, label: '' })
  assert.deepEqual(resolveTaskPill([{ content: 'a', status: 'pending' }]), { visible: true, label: '⇅ 1 任务' })
  assert.deepEqual(
    resolveTaskPill([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }]),
    { visible: true, label: '⇅ 2 任务 · 1 完成' },
  )
}

console.log('activity domain 守卫通过')
