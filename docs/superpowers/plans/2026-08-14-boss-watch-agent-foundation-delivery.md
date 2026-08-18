# Boss Watch Agent 基础交付计划

来源：`docs/superpowers/specs/2026-08-14-boss-watch-agent-foundation-design.md`

## Slice 1：只读对话分析

交付行为：给定虚构对话快照，返回最新招聘方消息的意图、精确原文证据和回复草稿。

验收证据：

- 简历请求被识别为 `resume_request`；
- Evidence 与输入消息逐字一致；
- 没有招聘方消息时不生成草稿；
- 测试不依赖网络、账号或模型密钥。

非目标：不实现浏览器采集和 LLM 分类。

## Slice 2：副作用审批边界

交付行为：调用方可查询任意动作是允许、需要审批还是拒绝；审批令牌只能用于完全相同的会话、收件人、内容和有效期。

验收证据：

- 所有发送类动作均要求审批；
- 未知动作默认拒绝；
- 修改消息内容、收件人或令牌后验证失败；
- 过期令牌验证失败。

非目标：不实现真实发送工具和审批 UI。

## Slice 3：Pi Agent Loop 接入

交付行为：Pi Agent 可以通过注册工具分析对话；工具串行执行；发送类工具不进入当前工具目录。

验收证据：

- Scripted Stream 触发真实 Pi 工具调用；
- Tool Result 包含结构化 `resume_request`；
- 全过程不调用远程模型；
- 类型检查与测试通过。

非目标：不配置 DeepSeek API。

## Slice 3A：Plan 与 Skill 契约

交付行为：对话任务按 `capture -> analyze -> draft -> approval_gate` 顺序推进，并提供一个可被 Pi 发现的 BOSS Conversation Watch Skill 文档。

验收证据：

- 跳过前置步骤会被拒绝；
- 重放已完成步骤不会改变结果；
- Skill 文档明确输入、Evidence、草稿和禁止动作；
- Skill 文档不拥有权限，Action Policy 仍是最终门禁。

非目标：不接入 Pi 的交互式 `/plan` UI。

## Slice 3B：Tool Registry 与 Application Event Journal

交付行为：业务 Tool 通过注册表声明原子操作和副作用等级；岗位、招聘方消息和面经以带幂等键的追加事件记录，不与 Pi Transcript 混淆。

验收证据：

- 未注册 Tool 默认拒绝；
- 外部副作用 Tool 必须声明为审批级别，审批 Action 不能伪装为只读 Tool；
- 同一应用和幂等键的重试返回原事件，证据变化时拒绝覆盖；
- Pi 集成测试证明发送类 Tool 在执行函数前被拦截；
- 当前实际注册目录仍只有只读对话分析 Tool。

非目标：不接入真实浏览器、SQLite、飞书写入或外部发送。

## Slice 3C：SQLite 事实库与用户导出

交付行为：使用 Node 内置 SQLite 在同一事务中保存原文 artifact 和追加事件，并允许用户显式导出
全部投递或单个投递的 JSON/Markdown 归档。

验收证据：

- SQLite 重开后仍能读取原文与事件；
- 事件哈希、artifact 引用或应用 ID 不一致时，事务不留下半条数据；
- 幂等键按 `applicationId` 隔离，双连接写入仍生成连续的应用内顺序号；
- 导出保留原文、哈希、稳定 ID、时间和事件顺序；
- CLI 拒绝不存在的数据库、数据库自覆盖和未显式允许的已有文件覆盖。

非目标：不把 SQLite 接到真实 Browser Tool，不自动同步飞书，不新增投递执行能力。

## Slice 4：演示与评测工件

交付行为：开发者可运行一个本地 Fixture Demo，并按文档复现测试和评测口径。

验收证据：

- `npm run demo` 输出结构化分析；
- README、架构、账号边界和评测文档与当前代码一致；
- Git diff 不包含凭据、真实聊天、简历或截图。

## 后续依赖顺序

```text
基础只读闭环
  -> DeepSeek Provider 离线评测
  -> Browser Adapter mock contract
  -> 授权账号只读捕获
  -> Checkpoint / resume
  -> 人工审批 UI
  -> 受控发送 canary
```

每一阶段都必须单独通过验收，不能因为后续计划存在就描述成已实现或已上线。
