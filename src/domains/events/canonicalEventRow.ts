/**
 * canonicalEventRow — canonical 事件行的形状契约与扁平→嵌套归一。
 *
 * 持久化与 wire 有两个形状，本模块是它们之间唯一的转换点（纯函数，无 IPC、无副作用）：
 * - `CanonicalEventWireRow`：后端 `canonical_events` 表的**扁平列**回读形状（`evt_list` /
 *   `evt_load_compact` / 即提交行通知的 `canonicalEvent`），owner 三元组是平铺列；
 * - `CanonicalEventRow`：前端内部与渲染消费的 canonical 事件（**嵌套 owner**，EVT-01）。
 *
 * `normalizeCanonicalEventRow` 对两种形状**幂等**（已是嵌套则原样保留），因此它同时
 * 服务于三处读边界：仓储回读、live 游标提交（`canonicalEventCursor`）、以及
 * `turn.unit` 内嵌事件的解析（`domains/events/canonicalUnit`）。凡有 canonical 事件
 * 进入领域层，都必须经过它——绕过形状归一曾导致嵌入扁平行被当作不可读（#81 回归：
 * 重启后整轮历史丢失）。
 */
import type {
  CanonicalConversationEvent,
  CanonicalEventIdentity,
  CanonicalEventOwner,
  CanonicalEventType,
} from './eventSchema'

/**
 * canonical_events 后端回读扁平行（EVT-02 wire，camelCase）：
 * 后端表为扁平列（profile_id/agent_id/local_session_id），`evt_list` 不回嵌套 owner。
 * `normalizeCanonicalEventRow` 负责归一为嵌套 owner 的 canonical 事件。
 */
export interface CanonicalEventWireRow {
  eventId?: string
  ownerKey?: string
  profileId?: string
  agentId?: string
  localSessionId?: string
  remoteSessionId?: string | null
  clientGeneration?: number
  sequence?: number
  occurredAt?: string
  receivedAt?: string
  eventType?: string
  payloadVersion?: number
  identity?: unknown
  typedPayload?: unknown
  rawPayload?: unknown
  createdAt?: number
  owner?: CanonicalEventOwner
  schemaVersion?: number
  provenanceOrigin?: CanonicalConversationEvent['provenance'] extends infer P ? P extends { origin: infer O } ? O : never : never
  provenanceTrust?: CanonicalConversationEvent['provenance'] extends infer P ? P extends { trust: infer T } ? T : never : never
  provenanceProvider?: string | null
  provenanceImportId?: string | null
  rawTruncated?: boolean
  rawOriginalBytes?: number | null
  rawRetainedBytes?: number | null
  rawOmittedBytes?: number | null
  rawTruncationReason?: string | null
}

/** canonical 事件（嵌套 owner；测试与前端内部使用形状）。 */
export type CanonicalEventRow = CanonicalConversationEvent & { createdAt?: number }

/**
 * 后端扁平行 → 嵌套 owner 的 canonical 事件；已是嵌套形状（测试/mock/未来 wire）原样保留。
 * 缺 owner 三元组的行会被归一为 unknown 事件（不抛错，调用方仍可取证）。
 */
export function normalizeCanonicalEventRow(value: unknown): CanonicalEventRow {
  const row = (value ?? {}) as CanonicalEventWireRow
  if (row.owner) {
    // SAFETY: 进入本分支即 `row.owner` 存在，说明输入本就是嵌套 owner 的 canonical
    // 事件（测试/mock/未来 wire），除下面补齐 schemaVersion/provenance/rawMetadata
    // 外与 CanonicalEventRow 字段同构；扁平行的 owner 三元组是平铺列，不会走到这里。
    return {
      ...(row as unknown as CanonicalEventRow),
      ...(row.schemaVersion !== undefined ? { schemaVersion: row.schemaVersion } : {}),
      ...(row.provenanceOrigin && row.provenanceTrust
        ? {
            provenance: {
              origin: row.provenanceOrigin,
              trust: row.provenanceTrust,
              ...(row.provenanceProvider ? { provider: row.provenanceProvider } : {}),
              ...(row.provenanceImportId ? { importId: row.provenanceImportId } : {}),
            },
          }
        : {}),
      ...(row.rawTruncated !== undefined
        ? {
            rawMetadata: {
              truncated: row.rawTruncated,
              originalBytes: row.rawOriginalBytes ?? 0,
              retainedBytes: row.rawRetainedBytes ?? 0,
              omittedBytes: row.rawOmittedBytes ?? 0,
              ...(row.rawTruncationReason ? { reason: row.rawTruncationReason } : {}),
            },
          }
        : {}),
    }
  }
  const owner: CanonicalEventOwner = {
    profileId: row.profileId ?? '',
    agentId: row.agentId ?? '',
    localSessionId: row.localSessionId ?? '',
    ...(row.remoteSessionId ? { remoteSessionId: row.remoteSessionId } : {}),
  }
  return {
    eventId: row.eventId ?? '',
    owner,
    ...(row.schemaVersion !== undefined ? { schemaVersion: row.schemaVersion } : {}),
    ...(row.provenanceOrigin && row.provenanceTrust
      ? {
          provenance: {
            origin: row.provenanceOrigin,
            trust: row.provenanceTrust,
            ...(row.provenanceProvider ? { provider: row.provenanceProvider } : {}),
            ...(row.provenanceImportId ? { importId: row.provenanceImportId } : {}),
          },
        }
      : {}),
    ...(row.rawTruncated !== undefined
      ? {
          rawMetadata: {
            truncated: row.rawTruncated,
            originalBytes: row.rawOriginalBytes ?? 0,
            retainedBytes: row.rawRetainedBytes ?? 0,
            omittedBytes: row.rawOmittedBytes ?? 0,
            ...(row.rawTruncationReason ? { reason: row.rawTruncationReason } : {}),
          },
        }
      : {}),
    clientGeneration: row.clientGeneration ?? 0,
    sequence: row.sequence ?? 0,
    occurredAt: row.occurredAt ?? '',
    receivedAt: row.receivedAt ?? '',
    eventType: (row.eventType as CanonicalEventType | undefined) ?? 'unknown',
    payloadVersion: row.payloadVersion ?? 1,
    ...(row.identity !== undefined && row.identity !== null
      ? { identity: row.identity as CanonicalEventIdentity }
      : {}),
    ...(row.typedPayload !== undefined && row.typedPayload !== null
      ? { typedPayload: row.typedPayload }
      : {}),
    rawPayload: row.rawPayload,
    ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
  }
}
