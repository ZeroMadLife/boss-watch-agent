# Tool Runtime 与业务事件边界

## 当前状态

当前项目使用 Pi Agent Core 的公共 `Agent`、`AgentTool` 和 `StreamFn` 接口。业务侧通过 `BossToolRegistry` 装配工具，当前实际注册的生产 Tool 只有：

| Tool | 原子操作 | 副作用等级 | 当前状态 |
| --- | --- | --- | --- |
| `analyze_conversation` | 分析一条对话 | `read_only` | 已实现 |
| `capture_job_description` | 捕获一份 JD | `read_only` | 契约已定义，未接 Browser |
| `capture_interview_note` | 记录一份面经 | `local_record` | 契约已定义，未注册 |
| `record_evidence` | 写入一条本地证据引用 | `local_record` | 契约已定义，未注册 |
| `propose_status_change` | 提议一次状态变化 | `proposal` | 契约已定义，未注册 |
| `sync_feishu` | 同步一条飞书投影 | `external_side_effect` | 默认需要审批，未实现 |
| `send_message` | 发送一条外部消息 | `external_side_effect` | 默认需要审批，未注册 |

“契约已定义”不等于能力已经上线。只有进入 `BossToolRegistry` 的 Tool 才会出现在 Pi 的工具目录中。

## 原子 Tool 规则

每个 Tool 只做一件事：

1. 输入必须对应一个明确资源，例如一条对话、一份 JD 或一条面试记录。
2. 输出必须带稳定 ID、来源或 Evidence 引用，不能只返回自然语言结论。
3. Tool 不能同时完成捕获、分析、发送等多个业务动作。
4. Tool 必须声明 `operation` 和 `effect`，运行时拒绝不一致的声明。
5. Tool 重试必须携带相同的业务幂等键，证据变化时拒绝覆盖旧事件。
6. 页面文本、模型输出和 Skill 文档都不能改变 Action Policy。

## 运行时门禁

```text
Pi Schema 校验参数
  -> BossToolRegistry 检查是否注册
  -> Action Policy 判断 allow / require_approval / deny
  -> Tool 执行单一操作
  -> Application Event Journal 记录可追溯事件
```

默认策略：

- 捕获、分析、本地证据、草稿和状态提议可以自动执行；
- 飞书同步、消息发送、发送简历、跟进和面试确认必须审批；
- 未知 Tool 或未知 Action 默认拒绝；
- 当前没有发送类 Tool，因此基础版本不可能通过 Pi 直接发送外部消息。

## 业务事实与 Pi Transcript

Pi Transcript 只记录模型轮次和 Tool Result，不是投递事实库。岗位、对话、面经和状态变化进入 `ApplicationEventStore`，每条事件包含：

- `applicationId`、`eventId`、`traceId`；
- `idempotencyKey` 和应用内顺序号；
- 原始内容的 SHA-256 和本地 artifact 引用；
- 事件类型、操作者和发生时间。

内存 Store 用于确定性单元测试；本地运行使用 `SqliteApplicationStore`。JD、招聘方消息和面经的
artifact 与对应事件在同一个事务内提交，状态提议作为无 artifact 事件追加。SQLite 使用 WAL、
外键和 5 秒 `busy_timeout`，允许多个本地进程各自持有连接；它仍是单机 MVP，不等同于服务端高并发队列。

## 后续接入顺序

1. 用只读 Browser Adapter 实现 `capture_job_description` 和 `capture_conversation`。
2. 将 SQLite Store 装配到尚未注册的捕获 Tool，保持一个 Tool 只写一类证据。
3. 将状态提议接入人工审批队列，审批后追加明确的投递结果事件。
4. 通过 `lark-cli base record-upsert` 做本地到飞书的幂等投影，默认不反向接收飞书编辑。
5. 最后才实现带 Fresh Capture、审批令牌和审计事件的发送 canary。

真实账号、登录、验证码、风控和发送不属于当前基础设施切片。
