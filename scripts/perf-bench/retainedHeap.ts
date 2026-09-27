/**
 * #376/#375 的 retained-heap 记账口径（纯函数，**不是** V8 实测）。
 *
 * 口径：从一组根对象出发遍历对象图，对**每个唯一对象只记一次**（`Set` 去重），据此估算
 * 保留字节。去重是这套口径的全部要害——「同一份载荷被两处持有」在这里表现为**只算一次**，
 * 所以它量的是「这份载荷还在不在」，不是「有几个引用」。这正好是 #375 要治的病
 * （同一载荷在 timeline / activities / fold.log 三处各留一份），并且完全确定性、与 GC 无关。
 *
 * 系数是**估算**，不是 V8 的真实占用。字符串按 V8 的实际表示计：Latin1 串 1 字节/单位、
 * 含非 Latin1 码位的串 2 字节/单位（+ 头）；对象按头 + 每条属性一个槽位。**这条必须与
 * 分母同一把尺子**——语料的 `Σ逻辑载荷` 是字符数（ASCII ⇒ 1 字符 1 字节），早期版本一律按
 * 2 字节/单位算分子，把比值抬高了约 2×（评审 M3：0.432× 实际相当于 ~0.22 份载荷，
 * 1.2× 的阈值实际允许 ~2.4 份）。因此本域只输出**比值**（驻留 / Σ逻辑载荷），不输出绝对 MB：
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

/** V8 实际表示：Latin1 串 1 字节/单位，含非 Latin1 码位的串 2 字节/单位。 */
function stringBytes(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0xff) return value.length * 2
  }
  return value.length
}

export function measureRetainedBytes(roots: readonly unknown[]): RetainedBytesReport {
  const seen = new Set<object>()
  let bytes = 0
  let objects = 0
  let strings = 0

  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      bytes += stringBytes(value) + STRING_HEADER_BYTES
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
