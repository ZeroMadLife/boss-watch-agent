# Boss Watch Agent

基于 [Pi Agent](https://github.com/earendil-works/pi) 的、审批门控的 BOSS 岗位与招聘对话盯盘 Agent。

项目当前处于基础工程阶段。第一阶段只处理虚构对话 Fixture，完成招聘方消息识别、原文证据保留、回复草稿生成和动作审批判断；尚未连接真实 BOSS 账号，也没有自动发送消息、简历或面试确认。

## 为什么选择 Pi Agent

- `@earendil-works/pi-agent-core` 提供 TypeScript Agent Loop、工具调用、事件与状态管理。
- 模型 Provider 与业务工具解耦，后续可接 DeepSeek 或其他兼容模型。
- BOSS 能力放在独立业务仓库，不修改 Pi 核心，便于跟随上游升级。
- Pi 不提供内置权限沙箱，因此本项目单独实现动作白名单、审批令牌与外部副作用边界。

## 当前执行链

```text
fictional conversation fixture
  -> Pi Agent Loop
  -> analyze_conversation tool
  -> deterministic intent baseline
  -> exact source evidence
  -> reply draft
  -> action policy
  -> approval required for every external side effect
```

## 安全边界

| 能力 | 当前策略 |
| --- | --- |
| 捕获对话 | 只读，可自动执行 |
| 消息分类 | 只读，可自动执行 |
| 回复草稿 | 只生成草稿，可自动执行 |
| 发送消息 | 必须人工审批，尚未实现 |
| 发送简历 | 必须人工审批，尚未实现 |
| 接受面试 | 必须人工审批，尚未实现 |
| 登录、验证码、风控 | 始终由人工处理 |

审批必须绑定 `sessionId + conversationId + recipientId + contentHash + expiresAt`。消息内容或接收人发生变化后，原审批立即失效。

## 本地运行

要求 Node.js `>=22.19.0`。

```bash
npm install --ignore-scripts
npm test
npm run check
npm run demo
```

`npm run demo` 只读取仓库内的虚构 Fixture，不访问 BOSS、不调用模型、不需要账号或密钥。

## 文档

- [基础架构设计](docs/superpowers/specs/2026-08-14-boss-watch-agent-foundation-design.md)
- [MVP 交付计划](docs/superpowers/plans/2026-08-14-boss-watch-agent-foundation-delivery.md)
- [评测与上线门槛](docs/evaluation.md)
- [真实账号与演示边界](docs/demo-account-boundary.md)
- [BOSS 对话 Skill](skills/boss-conversation-watch/SKILL.md)

## 仓库关系

```text
earendil-works/pi
  -> ZeroMadLife/pi              # 上游学习与通用实验 fork

ZeroMadLife/boss-watch-agent     # 独立 BOSS 业务项目
  -> pinned @earendil-works/pi-* dependencies
```

除非发现必须修改 Agent Runtime 的通用问题，否则业务代码不进入 Pi fork。
