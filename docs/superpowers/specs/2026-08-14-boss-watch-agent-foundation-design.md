# Boss Watch Agent 基础架构设计

日期：2026-08-14  
状态：已批准，进入基础实现

## 1. 问题

现有 BossHunter 已具备页面采集、规则预筛、LLM 评分和消息监测能力，但总体仍是固定 Pipeline。它缺少一个可观察、可插拔、能在每一步重新获得 Observation 并执行安全策略的 Agent Runtime。

新项目需要学习并实际使用 Pi Agent 的 Agent Loop、Tool、Skill 和 Session 模式，同时不能把真实账号、浏览器副作用和模型决策直接耦合起来。

## 2. 目标结果

第一阶段交付一个无需真实账号和模型密钥即可回放的只读闭环：

```text
对话快照
  -> Pi Agent 选择只读工具
  -> 识别最新招聘方消息意图
  -> 返回原文证据
  -> 生成候选回复草稿
  -> 判断后续动作是否需要人工审批
```

每个结论必须能追溯到输入消息，所有外部副作用默认禁止或要求审批。

## 3. 非目标

- 不自动注册、登录或验证 BOSS 账号。
- 不绕过验证码、企业认证或平台风控。
- 不自动发送消息、简历、跟进或面试确认。
- 不在第一阶段实现真实浏览器选择器、定时任务、分布式队列或多账号调度。
- 不修改 Pi Agent 核心代码来承载 BOSS 业务逻辑。
- 不把 Sage 的 Coding/RAG/Workspace 产品模块搬入本项目。

## 4. 架构决策

### 4.1 Runtime

使用固定版本的 `@earendil-works/pi-agent-core` 和 `@earendil-works/pi-ai`。业务仓库通过公共 `Agent`、`AgentTool` 和 `StreamFn` 接口接入 Pi，不依赖 Pi 仓库内部文件。

工具执行设为串行。浏览器会话属于有顺序的外部状态，同时执行打开页面、输入和发送等动作会产生竞态，不能使用 Pi 默认的并行工具执行策略。

### 4.2 业务模块

| 模块 | 职责 | 依赖 |
| --- | --- | --- |
| Domain | 对话、意图、证据和草稿的数据契约 | 无外部依赖 |
| Application | 从快照生成分析结果 | Domain |
| Pi Runtime | 把只读业务工具装配进 Agent Loop | Pi 公共 API |
| Action Policy | 对动作做 allow / require approval / deny | 纯规则 |
| Approval Token | 把一次批准绑定到精确副作用 | Node Crypto |
| Browser Adapter | 后续负责真实页面 Observation 和 Action | 当前不实现 |
| Evaluation | 固定 Fixture、断言和时延统计 | 公开业务接口 |

### 4.3 业务状态与 Agent Transcript 分离

Pi Transcript 记录模型轮次和工具结果，但它不是招聘业务事实库。未来的岗位、对话、审批和发送结果必须写入独立业务存储，并通过稳定 ID 关联 Trace。

```text
Agent transcript: 模型看到了什么、调用了什么工具
Business state:   哪个会话、哪条消息、哪个审批、是否实际发送
Audit evidence:   输入哈希、工具参数、动作结果和错误原因
```

### 4.4 Plan 与 Skill

Pi 的低层 Agent Loop 负责模型轮次和工具调用；招聘任务的顺序状态由业务侧 `ConversationExecutionPlan` 维护，避免把 Pi 的软性 Plan 提示误当成业务事实。当前计划固定为 `capture -> analyze -> draft -> approval_gate`，每一步可回放且只能按顺序完成。

`skills/boss-conversation-watch/SKILL.md` 遵循 Pi 的 Agent Skills 目录约定，描述输入契约、证据规则和安全边界。Skill 文档不是权限来源，最终动作仍由 Action Policy 和 Approval Token 决定。

## 5. 核心契约

### 5.1 Observation

`ConversationSnapshot` 至少包含：

- `conversationId`
- `candidateId`
- `recruiterId`
- 按时间排序的消息列表
- 每条消息的稳定 `id`、发送方、原文和时间

第一阶段只分析最新一条招聘方消息。没有招聘方消息时返回 `no_recruiter_message`，不生成草稿。

### 5.2 Evidence

分类结果必须携带：

- 命中的原消息 ID；
- 输入中的精确原文，不允许由模型改写后冒充证据。

### 5.3 Action Policy

只读观察、分析和草稿生成可以自动执行。发送消息、发送简历、安排跟进和接受面试必须返回 `require_approval`。未知动作默认 `deny`。

页面文本、模型输出和 Skill 内容都不能修改这条策略。

### 5.4 Approval Token

审批令牌必须覆盖：

```text
sessionId
conversationId
recipientId
contentHash
expiresAt
```

验证失败时只返回稳定错误类型，不泄露签名、密钥或内部比较值。签名密钥只从运行环境或密钥管理系统读取，不进入 Git、日志和对话。

## 6. 失败处理

| 失败 | 行为 |
| --- | --- |
| 输入没有招聘方消息 | 返回无动作结果 |
| 意图无法确定 | 返回 `other`，保留原文证据 |
| 模型请求失败 | 保留 Pi 错误事件，不执行副作用 |
| 工具参数不合法 | 由 Pi Schema 校验拒绝 |
| 未知工具或动作 | 默认拒绝 |
| 审批过期或范围不一致 | 拒绝动作并要求重新审批 |
| 登录、验证码、风险提示 | 暂停任务并交还人工 |

## 7. 验证决策

- Domain 行为通过虚构 Fixture 测试。
- Action Policy 覆盖允许、审批和未知拒绝三类分支。
- Approval Token 覆盖正常、过期、消息变化和令牌篡改。
- Pi 集成测试使用本地 Scripted Stream，验证真实 Agent Loop 会调用只读工具，不访问付费模型。
- 真实 BOSS 验收必须使用经过授权的账号和脱敏数据，且单独记录，不作为本阶段完成条件。

## 8. 兼容与升级

Pi 依赖固定到精确版本。升级必须先在独立分支运行类型检查和 Agent Loop 回放，再更新锁文件。业务代码只使用 Pi 公共导出，避免依赖 monorepo 私有路径。

## 9. 已知证据缺口

- 尚未确认 BOSS 招聘方测试账号的合法申请路径和认证要求。
- 尚未采集真实页面 DOM、网络协议或可用的官方接口证据。
- 尚未验证 DeepSeek Provider 在该业务 Prompt 上的分类质量、时延与成本。
- 尚未验证真实浏览器长连接、断线恢复和多会话调度。
