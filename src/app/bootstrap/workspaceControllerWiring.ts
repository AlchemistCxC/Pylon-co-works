/**
 * workspaceControllerWiring — 工作区编排端口的装配（B-2b）。
 *
 * 视图编排实现（workspace-sheets/workspaceController）经本模块注册进
 * plugin-runtime 的 workspaceControllerPort；模块副作用在应用装配期执行
 * （App.tsx / resetStores 各自 import 一次，与 identityCrossDomainWiring 同位）。
 */
import { registerWorkspaceControllerPort } from '../../plugin-runtime/workspaces/workspaceControllerPort.ts'
import {
  closeWorkspace,
  focusWorkspace,
  listOpenWorkspaces,
  openWorkspace,
} from '../../workspace-sheets/workspaceController.ts'

registerWorkspaceControllerPort({
  open: openWorkspace,
  focus: focusWorkspace,
  close: closeWorkspace,
  list: listOpenWorkspaces,
})
