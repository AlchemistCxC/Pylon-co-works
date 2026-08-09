# Harness v2 宪章

## 不可违反

1. 只修改任务卡 `scope.allow`；匹配 `scope.deny` 或仓库敏感区立即阻塞。
2. 不读取或修改 `docs/archive/`。
3. 不提交 `.env`、密钥、凭据明文、个人绝对路径、构建产物或本机缓存。
4. 不执行 `git push --force`、`git reset --hard`、`git clean -fdx`、批量删除、跳过 hooks 的提交。
5. 不在共享分支上开发；每名开发者的每张任务卡使用独立分支。
6. 不把测试通过写成真实应用通过；证据必须标明 L1/L2/L3。
7. 不自行改变已拍板产品行为。发现新取舍时写入 `未决策项.md` 并进入 `blocked_decision`。
8. 不在 contract 未冻结时修改共享 UI 基座、跨层 DTO、事件名、持久化 schema 或公共 CSS token。
9. 不以“顺手重构”为由扩大 scope。必要改动应拆新任务或 contract proposal。
10. 不覆盖对方未合并工作。跨机器协作只通过 fetch/rebase、commit、PR、handoff 和 frozen contract。

## Agent 自主权限

可自主决定：scope 内实现细节、测试补充、非产品性命名、局部重构、commit message、失败后的安全重试。

必须停下：产品行为取舍、文件归属争议、scope 外修改、共享契约变化、测试需要真实账号/密钥、不可逆数据迁移、连续两次同根因失败仍无新证据。

## 长程稳定规则

- 每完成一个可验收子任务立即运行 focused test 并提交。
- 每次中断前写 handoff，记录 base、HEAD、已完成、失败证据、下一条确定动作。
- 恢复时先验证 HEAD、工作区和依赖，不直接延续旧推断。
- 失败恢复最多两次同策略；第三次必须换验证路径或阻塞上报。
