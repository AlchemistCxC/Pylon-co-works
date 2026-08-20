/**
 * acpTypes — 兼容 re-export（P1-09 两阶段迁移）。
 *
 * wire 类型与 extract 的真实定义已迁入 `infrastructure/acp/chatContracts.ts`（归一化层
 * 收边界）；本文件仅转发导出，避免 import 面大爆炸。确认无消费者后可删除。
 */

export * from '../../infrastructure/acp/chatContracts.ts'
