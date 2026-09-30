import { tauriInvokeTransport } from '../infrastructure/acp/tauriTransport.ts'
import { createAgentClient } from '../infrastructure/acp/agentClient.ts'
import { createChatClient } from '../infrastructure/acp/chatClient.ts'
import { createSessionClient } from '../infrastructure/acp/sessionClient.ts'
import { createBrowserAgentClient } from '../infrastructure/tauri/browserAgentClient.ts'
import { createBrowserClient } from '../infrastructure/tauri/browserClient.ts'
import { createDocsClient } from '../infrastructure/tauri/docsClient.ts'
import { createGatewayClient } from '../infrastructure/tauri/gatewayClient.ts'
import { createInteractionResponseTransport } from '../infrastructure/acp/interactionTransport.ts'
import { createPetClient } from '../infrastructure/tauri/petClient.ts'
import { createRuntimeClient } from '../infrastructure/tauri/runtimeClient.ts'

/**
 * appClients — 应用组装期的统一 typed client 入口（FE-AUD-008 / A-V2 收口）。
 *
 * 此前视图层 20+ 文件各自 `createXxxClient({ invoke: tauriInvokeTransport })`
 * （生命周期口径不一：模块级 / useState / 每次调用新建），同一 client 家族各造
 * 一份。收敛后：视图/宿主模块只从本入口取 client，transport 注入与后续错误/重试
 * 口径有单一落点。
 *
 * 两类成员：
 * - **无状态 client**（chat/runtime/browser/docs/pet/browserAgentPanel）：进程级
 *   单例，直接取属性。
 * - **有状态 client**（agent/gateway 的 CAS revision 凭证、session 的 cold-mount
 *   turn 缓存）：工厂成员，按消费方会话新建——凭证/快照语义随消费方生命周期，
 *   不跨面板会话共享（跨会话复用会让冲突后的旧 revision 永远重放）。
 * 测试仍按既有口径 vi.mock 各 client 工厂或 @tauri-apps/api/core invoke——
 * 本模块在工厂 mocked 后构建，行为面不变。
 */

export interface AppClientSet {
  /** 有状态（CAS revision 凭证）：按消费方会话新建。 */
  readonly agent: () => ReturnType<typeof createAgentClient>
  /** 有状态（cold-mount turn 快照缓存）：按消费方会话/调用新建。 */
  readonly session: () => ReturnType<typeof createSessionClient>
  readonly chat: ReturnType<typeof createChatClient>
  readonly runtime: ReturnType<typeof createRuntimeClient>
  readonly browser: ReturnType<typeof createBrowserClient>
  /** 有状态（gateway 配置 revision 凭证）：按消费方会话新建。 */
  readonly gateway: () => ReturnType<typeof createGatewayClient>
  readonly docs: ReturnType<typeof createDocsClient>
  /** Browser Sheet 的 Agent 面板工具通道（BrowserAgentTransport 函数签名）。 */
  readonly browserAgentPanel: ReturnType<typeof createBrowserAgentClient>
  /** 桌面宠物后端通道（get_pet / pet_action）。 */
  readonly pet: ReturnType<typeof createPetClient>
  /** 交互应答通道工厂（per-request；agentWorkbenchCommands 的 respond 语义）。 */
  readonly interactionResponse: () => ReturnType<typeof createInteractionResponseTransport>
}

export function createAppClientSet(
  invoke: (cmd: string, args?: unknown) => Promise<unknown> = tauriInvokeTransport,
): AppClientSet {
  const transport = { invoke }
  return {
    agent: () => createAgentClient(transport),
    session: () => createSessionClient(transport),
    chat: createChatClient(transport),
    runtime: createRuntimeClient(transport),
    browser: createBrowserClient(transport),
    gateway: () => createGatewayClient(transport),
    docs: createDocsClient(transport),
    browserAgentPanel: createBrowserAgentClient(invoke),
    pet: createPetClient(transport),
    interactionResponse: () => createInteractionResponseTransport(transport),
  }
}

/** 进程级唯一实例：App 装配期即随本模块求值构建。 */
export const appClients: AppClientSet = createAppClientSet()
