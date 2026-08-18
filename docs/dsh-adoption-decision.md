# DSH 作为求职 Agent 底座：研究与决策

文档命令使用下面的本机变量，不绑定维护者目录：

```bash
export BOSS_WATCH_DIR=/path/to/boss-watch-agent
export DSH_SOURCE_DIR=/path/to/deepseek-harness
```

日期：2026-08-17
状态：无 Side Panel 岗位捕获切片已实现，待真实账号体验评审
适用范围：`boss-watch-agent`（含 `packages/dsh-plugin`）、DSH 学习博客

## 1. 结论先说

我们采用 DeepSeek Harness（DSH）作为求职 Agent 的交互和 Agent Runtime 底座，但不把 BOSS 业务代码直接写进 DSH 本体。

```text
deepseek-harness                 DSH 上游源码
  └─ 本地源码学习、版本验证、必要时提交上游 PR

boss-watch-agent                 BOSS 领域事实与安全边界
  └─ Browser Controller、页面观察、内容哈希、SQLite、审批策略、导出

packages/dsh-plugin              业务仓内 DSH 插件包
  ├─ 当前：Host 工具、Browser Controller client、SQLite adapter、DSH bundle
  └─ 未来：RPC、Skills、Web UI
```

因此当前不直接 fork DSH 做业务分支。先使用已有本地 clone 作为只读上游，在业务仓内开发插件包。只有出现下面三类情况才创建公开 fork 和长期分支：

1. DSH 缺少一个通用、可复用的公开扩展接口，而且插件无法绕开；
2. 发现上游 bug，需要在等待合并期间维护临时修复；
3. 准备向 DSH 提交 PR，需要一个可审阅的补丁分支。

产品功能、BOSS 选择器、岗位领域模型、飞书字段和个人审批逻辑不属于 DSH fork。

## 2. 当前证据边界

下面的“已确认”来自当前 checkout 或公开仓库；“设计”是本项目方案，尚未称为已上线。

| 结论 | 类别 | 证据 |
|---|---|---|
| `dsh web` 提供 Web UI，默认监听本地地址，可通过 `--port` 修改 | 已确认 | DSH CLI help；`apps/cli` |
| DSH 的可安装扩展以 `dsh.bundle` + `cordis.patch.yml` 组装进 profile | 已确认 | DSH `docs/user/develop/basic/publish.zh.md` |
| 工具通过 Cordis context 注册，参数和输出由 schema 约束 | 已确认 | DSH `docs/user/develop/basic/tool.zh.md` |
| Client 与 Host 可以通过 `connection.rpc` 传递结构化数据 | 已确认 | DSH `packages/client/connection` 测试和 API 文档 |
| 社区插件采用 Host/Client 双半部分、独立仓库和端到端验证 | 已确认 | `cnyac/dsh-polling` 的 `DESIGN.md` |
| 结构化输出、provider/fallback、安全说明和测试是可复用的插件实践 | 已确认 | `liustack/modlens` 的 `docs/output-schema*`、`docs/security*`、`docs/testing.md` |
| 当前 `boss-watch-agent` 已有 SQLite、只读捕获、审批和导出 | 已实现 | 本仓库 `src/`、`test/`、`docs/` |
| DSH 已接入五个事实工具、四个受控浏览器工具和一个 Skill | 已实现并本地验证 | 独立插件的 Tool Schema、HTTP client、Cordis Loader 测试和构建 |
| 当前 BOSS 岗位页只读捕获 | 已实现，待真实账号验收 | `boss_watch_browser_status`、`boss_watch_capture_current_job` 和 4318 Browser Controller |
| DSH Client 岗位面板、表单动作或飞书写入 | 未实现 | 当前通过 Host tools 发现岗位卡片、受控读取完整 JD；没有对应 Client 或外部写入代码 |

## 3. 为什么用插件，不直接改 DSH

### 3.1 DSH 已经提供的能力

- Agent Loop、Turn/Step、Session Event 和消息投影；
- Tool Registry、参数校验、工具结果渲染；
- Skills、Jobs、Goal、Profile/Bundle 等可选能力；
- Web UI、Workspace、会话和 Client/Host 连接；
- `dsh plugin` 的本地目录、npm、GitHub 和 tarball 安装路径。

这些能力属于通用运行时，求职 Agent 只需要通过公开接口组合它们。

### 3.2 业务真正需要自己拥有的能力

- BOSS 页面只是**不可信观察输入**，不能授予任何工具权限；
- 岗位、JD、招聘方消息、投递状态和面经是业务事实，不是 DSH Transcript；
- SQLite 事实库、内容哈希、幂等键、导出格式和飞书投影属于本项目；
- 登录、二维码、验证码和风控必须由人操作；
- 发送消息、发送简历、接受面试和外部写入必须有精确的人工审批令牌。

把这些写入 DSH fork 会把上游同步、业务隐私和发布节奏耦合在一起，也会让每次 DSH 升级都变成业务合并风险。

## 4. 目标架构

```text
DSH Web UI
  ├─ 对话与 Agent Loop
  ├─ Session / Workspace / Skills
  └─ boss-watch-dsh-client
       ├─ 岗位列表与 JD 详情
       ├─ 投递时间线
       ├─ 面经入口
       └─ 风险确认状态

DSH Host
  └─ boss-watch-dsh-host
       ├─ boss_watch_job_list / boss_watch_job_get
       ├─ boss_watch_browser_status / boss_watch_capture_current_job
       ├─ boss_watch_application_timeline / boss_watch_application_overview
       ├─ boss_watch_feishu_preview
       ├─ boss-watch-job-search Skill
       ├─ interview_note_search
       ├─ connection.rpc（Client -> Host）
       └─ boss-watch-agent adapter
              ├─ Browser Controller / Side Panel 兼容入口
              ├─ BossHunter CDP Runtime
              ├─ SHA-256 artifact
              ├─ SQLite 事实库
              └─ Action Policy / Approval Token

Chrome Side Panel（可选）
  └─ 页面适配器调试 / 聊天捕获 / 故障回退
```

DSH Web 是用户与 Agent 的工作台；`boss-watch-agent` 才是招聘事实的持久化边界。DSH Transcript 只能记录 Agent 看到了什么、调用了什么工具，不能替代业务事件账本。

## 5. 已交付切片

第一版完成事实查询，第二版完成无 Side Panel 的当前岗位捕获，均不自动联系招聘方：

1. `boss_watch_job_list`：读取本地已捕获岗位；
2. `boss_watch_job_get`：读取一个 JD 的正文、哈希和 artifact 引用；
3. `boss_watch_application_timeline`：读取一个投递的追加事件，不允许覆盖旧事实；
4. DSH Web profile 安装插件后，模型配置完成即可用自然语言调用工具，Skill 负责按需加载边界；
5. 数据库缺失或损坏时返回稳定状态，不把错误伪装成空结果；
6. `boss_watch_browser_status`：核对 Runtime、Chrome 和唯一岗位标签页；
7. `boss_watch_capture_current_job`：固定提取器读取岗位并通过现有 CaptureApi 幂等落库；
8. Client 面板用 RPC 展示同一份结构化结果，留作下一条切片。

首版明确不做：自动发消息、自动投递简历、自动接受面试、绕过风控、飞书自动写入、多账号并发和 Redis 队列。

## 6. 仓库、分支和发布策略

### DSH 上游仓库

`$DSH_SOURCE_DIR` 应是 `https://github.com/deepseek-ai/deepseek-harness.git` 的独立 clone。可以直接更新官方
默认分支并在业务仓执行兼容测试；只有准备通用上游补丁时才创建个人 fork 和研究分支：

```bash
git -C $DSH_SOURCE_DIR fetch origin --tags
git -C $DSH_SOURCE_DIR switch master
git -C $DSH_SOURCE_DIR pull --ff-only origin master
```

如需上游分支，它只放最小复现和准备提交给上游的通用修复。没有上游补丁时，不 fork DSH，也不在 DSH
仓库写 BOSS 业务。

### 业务插件仓库

业务仓内 `$BOSS_WATCH_DIR/packages/dsh-plugin` 是本地 npm 包，当前结构是：

```text
packages/dsh-plugin/
  src/index.ts             # Host plugin entry
  src/domain.ts            # 工具输入输出契约
  src/tools.ts             # 事实查询与受控浏览器模型工具
  src/browser-controller-client.ts
  src/sqlite-source.ts     # 只读 SQLite adapter
  cordis.patch.yml
  package.json             # dsh.bundle
  test/
```

`dsh.client` 已提供简历和招聘进度文件选择按钮；岗位结果仍由 Host 工具展示，独立岗位面板属于可选切片。

开发期使用业务仓内本地目录安装；验收期用业务仓固定 commit 的构建产物；发布期优先使用预构建 npm 包。DSH
官方 checkout 只用于兼容验证，不随业务仓发布。

### 版本升级顺序

```text
DSH 版本升级
  -> 独立兼容分支
  -> typecheck / unit / built-plugin smoke test
  -> DSH Web 本地启动
  -> 插件验收
  -> 更新锁定版本
```

不把未验证的 DSH `main` 或 Git HEAD 作为生产依赖。

## 7. 测试与可观测性门槛

### 插件层

- Domain：岗位、JD、时间线事件的 schema、幂等键和脱敏规则；
- Tool：参数非法、空结果、证据引用和只读副作用等级；
- RPC：未知 endpoint、错误编码、请求取消和连接未组合；
- Client：没有 Host 时显示不可用，不把空数据伪装成“没有岗位”；
- Built smoke：从打包插件安装到 `dsh web` 启动，工具可见且 UI 可打开。

### 业务事实层

- 原文 artifact 的 hash 可复算；
- 相同幂等键重放不会产生第二条事实；
- 状态变化只能追加事件，不能修改历史；
- 导出包含稳定 ID、时间、来源、哈希和证据引用；
- 审批绑定 `sessionId + conversationId + recipientId + contentHash + expiresAt`。

### 观测指标（先定义，再测量）

- Tool 成功率、schema 拒绝率和错误类型分布；
- DSH Agent turn 的 P50/P95/P99 时延；
- SQLite 写入 P50/P95/P99；
- 页面捕获到事实库的端到端 P50/P95/P99；
- 未授权动作拦截率；
- 数据重复率和事件幂等命中率。

这些是上线前的测量口径，不是当前已经获得的生产 SLA。

## 8. 研究来源

官方与源码：

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- 本地 DSH `docs/user/develop/basic/publish.zh.md`：bundle/profile、GitHub 安装和 `allowBuilds`
- 本地 DSH `docs/user/develop/basic/tool.zh.md`：工具注册、参数和输出 schema
- 本地 DSH `docs/api-gateway.zh.md` 与 `packages/client/connection`：RPC 通道

社区实现：

- [cnyac/dsh-polling](https://github.com/cnyac/dsh-polling)：独立仓库、Host/Client 双半部分、持久化、调度和 E2E
- [zhu1090093659/dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui)：多个 Web UI 插件和聚合包，提醒 workspace/link 的维护成本
- [lsz-asd/dsh-plugin-session-delete](https://github.com/lsz-asd/dsh-plugin-session-delete)：Host 领域动作与 Client 操作共用逻辑，并在危险动作前确认
- [liustack/modlens](https://github.com/liustack/modlens)：结构化输出、provider/fallback、安全文档和测试
- [onychen/learn-dsh](https://github.com/onychen/learn-dsh)：先运行、再观察、再讲源码的课程组织方式

协作流程：

- [GitHub: Contributing to a project](https://docs.github.com/en/get-started/exploring-projects-on-github/contributing-to-a-project)
- [GitHub: Syncing a fork](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/syncing-a-fork)

## 9. 已完成的本地验证

在隔离的临时 `DSH_HOME` 下运行：

```bash
npm run dsh -- --profile web --port 0
```

DSH 源码成功启动 Web 服务，实际监听 `http://127.0.0.1:55614`，随后手动停止进程。这个结果只证明当前 checkout 的 Web 启动链路可运行。随后完成独立插件的类型检查、单元测试、构建和 Cordis Loader 真实组合测试；插件以 `link:` 依赖安装至本地 Web profile，并已在 `http://127.0.0.1:3080/` 启动验证。该结果不代表真实模型已配置，也不代表 BOSS 页面、表单自动化或飞书已接通。

## 10. 下一步

1. 用虚构 fixture 和授权测试账号持续回归页面适配、登录/风控 handoff 与临时标签页生命周期；
2. 根据真实使用频率决定是否加入 `dsh.client` 岗位面板；
3. 外部填写、提交或消息动作必须先完成逐动作 Gate B 契约和聚焦测试；
4. DSH 升级时记录最后验证通过的上游 commit，并运行根项目与插件的完整兼容门槛。
