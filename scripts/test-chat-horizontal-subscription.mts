import { strict as assert } from 'node:assert'
import { createHorizontalSubscription } from '../src/components/chat/horizontalSubscription.ts'

// P1-05：横向订阅版本戳——source A 更新不通知 B、unsubscribe 后不通知、
// changed=false 不递增不通知、prune/dispose 清理生命周期

// 1. 初始版本为 0；changed=false 不递增不通知
{
  const sub = createHorizontalSubscription()
  let notified = 0
  sub.subscribe('A', () => { notified += 1 })
  sub.bump('A', false)
  assert.equal(notified, 0, 'changed=false 不得通知')
  assert.equal(sub.getSnapshot('A'), 0)
  sub.bump('A', true)
  assert.equal(notified, 1)
  assert.equal(sub.getSnapshot('A'), 1)
}

// 2. source A 更新不通知 B（隔离）
{
  const sub = createHorizontalSubscription()
  const aNotifications: number[] = []
  const bNotifications: number[] = []
  sub.subscribe('A', () => aNotifications.push(sub.getSnapshot('A')))
  sub.subscribe('B', () => bNotifications.push(sub.getSnapshot('B')))
  sub.bump('A', true)
  sub.bump('A', true)
  sub.bump('B', true)
  assert.deepEqual(aNotifications, [1, 2], 'A 只收到自己的更新')
  assert.deepEqual(bNotifications, [1], 'B 只收到自己的更新')
  assert.equal(sub.getSnapshot('A'), 2)
  assert.equal(sub.getSnapshot('B'), 1)
}

// 3. unsubscribe 后不再通知；重复 unsubscribe 安全
{
  const sub = createHorizontalSubscription()
  let notified = 0
  const unsub = sub.subscribe('A', () => { notified += 1 })
  sub.bump('A', true)
  unsub()
  sub.bump('A', true)
  assert.equal(notified, 1, '退订后不得再通知')
  unsub() // 幂等
  sub.bump('A', true)
  assert.equal(notified, 1)
}

// 4. 多订阅者各自收到通知；退订单个不影响其他
{
  const sub = createHorizontalSubscription()
  let first = 0
  let second = 0
  const unsub1 = sub.subscribe('A', () => { first += 1 })
  sub.subscribe('A', () => { second += 1 })
  sub.bump('A', true)
  assert.equal(first, 1)
  assert.equal(second, 1)
  unsub1()
  sub.bump('A', true)
  assert.equal(first, 1, '退订的订阅者不再收到')
  assert.equal(second, 2, '其他订阅者继续收到')
}

// 5. listener 内退订不干扰本轮通知（快照遍历）
{
  const sub = createHorizontalSubscription()
  let first = 0
  const unsub = sub.subscribe('A', () => { first += 1; unsub() })
  sub.subscribe('A', () => {})
  sub.bump('A', true)
  assert.equal(first, 1, 'listener 内退订不中断本轮其他订阅者')
}

// 6. prune：清理孤儿 source 的版本与监听器；active source 保留
{
  const sub = createHorizontalSubscription()
  let notified = 0
  sub.subscribe('A', () => { notified += 1 })
  sub.bump('A', true)
  sub.bump('B', true)
  sub.prune(['A'])
  assert.equal(sub.getSnapshot('B'), 0, 'prune 必须清孤儿版本')
  sub.bump('A', true)
  assert.equal(notified, 2, 'active source 监听器保留（继续收到通知）')
  sub.bump('B', true)
  assert.equal(notified, 2, 'prune 后孤儿 source 无监听器')
}

// 7. dispose：清空全部监听器，但版本可继续（controller dispose 后不再有订阅者）
{
  const sub = createHorizontalSubscription()
  let notified = 0
  sub.subscribe('A', () => { notified += 1 })
  sub.dispose()
  sub.bump('A', true)
  assert.equal(notified, 0, 'dispose 后不得通知')
}

// 8. 消息 append 场景等价：对 A 的多次 bump 不带动 B（横向组件独立于消息 setState 链）
{
  const sub = createHorizontalSubscription()
  let aRender = 0
  let bRender = 0
  sub.subscribe('A', () => { aRender += 1 })
  sub.subscribe('B', () => { bRender += 1 })
  // 模拟 source A 消息流多次 append（每次 runtime 引用变化 → bump A）
  for (let i = 0; i < 10; i += 1) sub.bump('A', true)
  assert.equal(aRender, 10)
  assert.equal(bRender, 0, 'A 的消息 append 不得造成 B 的横向渲染')
}

console.log('chat horizontal subscription 守卫通过')
