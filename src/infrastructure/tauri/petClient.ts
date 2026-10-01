import type { ClientTransport } from '../acp/agentClient.ts'

/**
 * petClient — 桌面宠物后端通道（A-V2 裸 invoke 收口）。
 * 命令面：`get_pet`（后端权威状态）与 `pet_action`（poke/feed 等行为上报）；
 * 返回保持 unknown，DTO 归一化由消费方（petContracts.normalizePetState）承担。
 * #483：前端宠物 UI（PetCompanion）已删除，本通道与 Rust `src/pet` 命令层、
 * `pet-core` 领域 crate 一并保留，供将来重做宠物 UI 时再启用。
 */
export function createPetClient(transport: ClientTransport) {
  return {
    getState: (): Promise<unknown> => transport.invoke('get_pet'),
    act: (action: string, value?: unknown): Promise<unknown> =>
      transport.invoke('pet_action', value === undefined ? { action } : { action, value }),
  }
}

export type PetClient = ReturnType<typeof createPetClient>
