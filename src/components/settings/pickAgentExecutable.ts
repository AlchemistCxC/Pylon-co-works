import { IS_TAURI } from '../../infrastructure/tauri/env'

/**
 * 选一个 Agent 可执行文件（编辑/新建共用）：Tauri 下走系统文件对话框
 * （exe/cmd/bat）；浏览器 mock 用可控 prompt（测试注入返回值）。
 */
export async function pickAgentExecutable(): Promise<string | null> {
  if (IS_TAURI) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: '可执行文件', extensions: ['exe', 'cmd', 'bat'] }],
    })
    return typeof selected === 'string' ? selected : null
  }
  // 浏览器 mock：可控替代行为（测试注入 prompt 返回值）。
  return window.prompt('输入可执行文件路径（exe/cmd/bat）')
}
