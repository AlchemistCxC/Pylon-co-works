/**
 * #376/#375 的 retained-heap 记账口径（纯函数，**不是** V8 实测）。
 *
 * 口径：从一组根对象出发遍历对象图，对**每个唯一对象只记一次**（`Set` 去重），据此估算
 * 保留字节。去重是这套口径的全部要害——「同一份载荷被两处持有」在这里表现为**只算一次**，
 * 所以它量的是「这份载荷还在不在」，不是「有几个引用」。这正好是 #375 要治的病
 * （同一载荷在 timeline / activities / fold.log 三处各留一份），并且完全确定性、与 GC 无关。
 *
 * 系数是**估算**，不是 V8 的真实占用（字符串按 UTF-16 两字节 + 头，对象按头 + 每条属性
 * 一个槽位）。因此本域只输出**比值**（驻留 / Σ逻辑载荷），不输出绝对 MB：
 * 换机器、换语料都还能比。真实进程峰值由 `proc-tree.ps1` + `performance.memory` /
 * `HeapProfiler.collectGarbage` 在实机上取（见 README「memory 域」）。
 */

export interface RetainedBytesReport {
  /** 估算保留字节（唯一对象去重后） */
  readonly bytes: number
  /** 去重后计入的对象/数组个数 */
  readonly objects: number
  /** 去重后计入的字符串个数 */
  readonly strings: number
}

const STRING_HEADER_BYTES = 16
const OBJECT_HEADER_BYTES = 32
const SLOT_BYTES = 8
const PROPERTY_BYTES = 24

export function measureRetainedBytes(roots: readonly unknown[]): RetainedBytesReport {
  const seen = new Set<object>()
  let bytes = 0
  let objects = 0
  let strings = 0

  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      bytes += value.length * 2 + STRING_HEADER_BYTES
      strings += 1
      return
    }
    if (value === null || typeof value !== 'object') {
      bytes += SLOT_BYTES
      return
    }
    const object = value as object
    if (seen.has(object)) return
    seen.add(object)
    objects += 1
    if (Array.isArray(object)) {
      bytes += OBJECT_HEADER_BYTES + object.length * SLOT_BYTES
      for (const item of object) visit(item)
      return
    }
    const record = object as Record<string, unknown>
    const keys = Object.keys(record)
    bytes += OBJECT_HEADER_BYTES + keys.length * PROPERTY_BYTES
    for (const key of keys) {
      bytes += key.length * 2
      visit(record[key])
    }
  }

  for (const root of roots) visit(root)
  return { bytes, objects, strings }
}
