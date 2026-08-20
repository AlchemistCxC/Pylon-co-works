/**
 * attachmentItem — 附件域（报告 7B / FE-AUD-019）。
 *
 * AttachmentItem 状态机：validating → ready/error → sending → 成功清除。
 * 纯 TS（node 可测）：选择后校验重复、扩展名、大小；区分 image 与 file-path
 * 能力由调用方（resolveAttachFilters）决定，本域只做单项校验与状态迁移。
 */

export type AttachmentKind = 'image' | 'text' | 'unknown'
export type AttachmentStatus = 'validating' | 'ready' | 'error' | 'sending'

export interface AttachmentItem {
  id: string
  path: string
  name: string
  kind: AttachmentKind
  status: AttachmentStatus
  error?: string
  /** 文件大小（字节）；由调用方（Input 侧）在创建时提供，供 maxBytes 校验 */
  sizeBytes?: number
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp']
const TEXT_EXTENSIONS = ['txt', 'md', 'log', 'json', 'yaml', 'yml', 'csv']

/** 附件大小上限（字节）——ISSUE-15 W4：capability/config 的单一 contract，
 * 超限在进入发送队列前可见拒绝（Input 侧传 sizeBytes + 本上限校验）。 */
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024

export function resolveAttachmentKind(name: string): AttachmentKind {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  if (IMAGE_EXTENSIONS.includes(extension)) return 'image'
  if (TEXT_EXTENSIONS.includes(extension)) return 'text'
  return 'unknown'
}

export function createAttachment(path: string, name: string, sizeBytes?: number): AttachmentItem {
  return {
    id: `${path}:${Date.now().toString(36)}`,
    path,
    name,
    kind: resolveAttachmentKind(name),
    status: 'validating',
    sizeBytes,
  }
}

export interface AttachmentValidationOptions {
  /** 重复检测：已选附件路径集合 */
  existingPaths: ReadonlySet<string>
  /** 大小上限（字节）；不设则跳过 */
  maxBytes?: number
}

export type AttachmentValidation = { ok: true } | { ok: false; error: string }

export function validateAttachment(item: AttachmentItem, options: AttachmentValidationOptions): AttachmentValidation {
  if (options.existingPaths.has(item.path)) return { ok: false, error: '该文件已在附件列表' }
  if (item.kind === 'unknown') return { ok: false, error: '不支持的附件类型' }
  // ISSUE-15 W4：maxBytes 落地——超限在进入发送队列前可见拒绝（项含 sizeBytes 时生效）
  if (options.maxBytes !== undefined && item.sizeBytes !== undefined && item.sizeBytes > options.maxBytes) {
    return { ok: false, error: `附件超过大小限制（最大 ${options.maxBytes} 字节）` }
  }
  return { ok: true }
}

/** 状态迁移（纯函数）：validating/ready → sending；error 保留原错误 */
export function toSending(item: AttachmentItem): AttachmentItem {
  return item.status === 'error' ? item : { ...item, status: 'sending' }
}
