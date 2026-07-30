# session-routing.v1

状态：frozen（身份不变量）；具体错误 DTO 仍 proposed。

- `Session.id`：前端本地实体。
- `source`：Pylon/Tauri command/event scope。
- `periId`：ACP 远端 sessionId。
- `sessionGeneration`：本地 mapping 代际。
- `clientGeneration`：active ACP client 代际。

所有异步 mutation 在 await 后、本地写入前验证 source + periId + 两级 generation。远端 notification 只有 sessionId 时，必须在当前 generation 唯一恢复 source；无匹配或多匹配则丢弃并诊断。
