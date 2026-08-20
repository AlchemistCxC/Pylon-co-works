/**
 * core.projector.canonicalMessage —— 内置 canonical 消息投影器。
 *
 * 由产品 workspace 插件登记进 owner-aware Plugin Service Registry。
 */
import {
  type EventProjector,
} from '../../../contracts/eventProjector.ts'
import {
  projectMessagesFromCanonicalBuiltin,
} from '../../../domains/events/messageProjection.ts'
import type { CanonicalConversationEvent } from '../../../domains/events/eventSchema.ts'

export const CORE_PROJECTOR_PLUGIN_ID = 'core.projector.canonicalMessage'

export const BUILTIN_CANONICAL_MESSAGE_PROJECTOR: EventProjector = {
  projectorId: CORE_PROJECTOR_PLUGIN_ID,
  eventTypes: [],
  project: events => projectMessagesFromCanonicalBuiltin(events as readonly CanonicalConversationEvent[]),
}
