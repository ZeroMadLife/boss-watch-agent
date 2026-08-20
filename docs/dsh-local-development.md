# DSH 本地协同开发

## 目标

`boss-watch-agent` 保留业务事实和安全边界，`deepseek-harness` 保留 DSH 上游源码。两者通过本地启动器协同，不把 DSH 源码复制到业务仓库，避免出现两份 checkout 漂移。

```text
Codex / 本地编辑器
  ├─ boss-watch-agent：Browser Controller、SQLite、BOSS Adapter、审批
  │    └─ packages/dsh-plugin：事实查询、来源导入与受控浏览器 Host 工具
  └─ deepseek-harness：DSH Runtime、Web UI、Cordis 源码
                         │
                         └─ npm run dsh:dev
                              -> http://127.0.0.1:3080
```

## 路径变量与前置条件

先按本机 checkout 设置下面三个变量；文档中的命令不依赖某个用户目录：

```bash
export BOSS_WATCH_DIR=/path/to/boss-watch-agent
export DSH_SOURCE_DIR=/path/to/deepseek-harness
export BOSS_HUNTER_DIR=/path/to/BossHunter
```

- 业务仓库：`$BOSS_WATCH_DIR`
- 插件包：`$BOSS_WATCH_DIR/packages/dsh-plugin`
- DSH 源码：`$DSH_SOURCE_DIR`
- DSH checkout：官方仓库的独立 clone；业务开发不要求固定分支名
- DSH 依赖：按上游仓库说明安装后再启动本项目

DSH 源码仓库保持独立。需要阅读或修改 DSH 通用能力时，在 DSH 仓库单独创建分支；求职业务不直接写入 DSH 仓库。
公开 CI 当前固定验证 `deepseek-harness@141eb6fef83422698aef7a981029e843e8161534`
（`dsh-v0.1.0-rc.8`）。插件构建使用仓内的外部插件 preset，不再导入 DSH monorepo 私有构建辅助。
稳定兼容声明只跟随通过完整 CI 的 pinned commit。

## 启动 Browser Runtime 与本地服务

DSH 不直接获得 Playwright/CDP 权限。先启动 BossHunter 自带的本地 CDP Bridge，再启动 4318 Controller：

```bash
cd $BOSS_HUNTER_DIR
node src/bosshunter/browser/runtime/check-runtime.mjs

cd $BOSS_WATCH_DIR
npm run serve
```

Chrome 远程调试、BOSS 登录、二维码、验证码和风险提示仍由用户处理。`npm run serve` 首次启动会在
`~/Library/Application Support/BossWatchAgent/dsh-service-token` 创建 `0600` 服务凭据。DSH Host 自动读取，
普通网页 Origin、无凭据本机进程和 Chrome Extension 都不能调用 Browser Controller 接口。

`/api/v1/health` 会返回 `apiContractVersion`、`buildIdentity` 和 `startedAt`。业务仓重新构建后必须重启
4318；DSH 写工具在读取 token 或发送写请求前先校验契约，旧进程会明确返回
`controller_restart_required`。不要用模糊的 401 判断凭据失效，也不要因端口占用杀死未知进程。

## 启动 DSH Web

在 `boss-watch-agent` 根目录运行：

```bash
npm run dsh:dev
```

默认配置：

- `DSH_SOURCE_DIR`：优先寻找业务仓同级的 `deepseek-harness-rc8`，不存在时回退到 `deepseek-harness`
- `DSH_PROFILE=web`
- `DSH_WEB_PORT=3080`
- `DSH_HOME`：rc.8 默认使用 `~/Library/Application Support/BossWatchAgent/dsh-rc8-compat`；旧 checkout 使用 `.../dsh`

rc.8 的 DSH 自身 SQLite 存储格式与旧版不兼容，因此两个 `DSH_HOME` 必须隔离。Boss Watch 的业务 SQLite
不受该变化影响；不要把旧 DSH storage 文件直接复制到 rc.8 目录。

自定义 DSH checkout 或端口：

```bash
DSH_SOURCE_DIR=/path/to/deepseek-harness DSH_WEB_PORT=3081 npm run dsh:dev
```

启动成功后打开 `http://127.0.0.1:<port>`。端口被占用时不要覆盖已有进程，改用一个明确的新端口。

## NewAPI 视觉路由

视觉 provider 只在本机运行时配置，API key 通过 `NEWAPI_API_KEY` 环境变量或 DSH credentials
引用提供，不写入仓库、Skill、Transcript 或日志。当前已验证 `claude-opus-5`、`gpt-5.6-sol` 和
`gpt-5.6-terra` 接受图片；`glm-5.2` 由服务端明确标记为文本-only。DSH Web profile 中的
`dsh-vision-subagent` 默认路由为 `newapi-vision/gpt-5.6-sol`；`npm run dsh:dev`
通过 [`scripts/dsh-vision-default.patch.yml`](../scripts/dsh-vision-default.patch.yml) 在 profile 层之后覆盖该配置。
直接使用 DSH CLI 或桌面端启动时，如 profile 的 `cordis.patch.yml` 仍是旧值，需要把其中
`vision-subagent.model` 改为 `gpt-5.6-sol`。

NewAPI 对 OpenAI function Schema 要求显式 `required` 数组；本地 DSH pi-ai 适配层会将空参数
工具规范化为 `required: []`。这只影响发送给兼容网关的 Schema，不改变插件注册和执行契约。

## 安装和验证只读插件

当前 DSH Web profile 的依赖中已链接业务仓内的 `packages/dsh-plugin`。在新机器或清理 profile 后，先安装并构建该包，再显式安装它：

```bash
cd $BOSS_WATCH_DIR/packages/dsh-plugin
corepack pnpm install
corepack pnpm run build

cd $DSH_SOURCE_DIR
DSH_HOME="$HOME/Library/Application Support/BossWatchAgent/dsh" \
  node --import tsx/esm apps/cli/src/bin.ts \
  plugin --profile web add $BOSS_WATCH_DIR/packages/dsh-plugin
```

重启 `npm run dsh:dev` 后，DSH 模型可调用下列 Host 工具：

| 工具 | 数据来源 | 副作用 |
| --- | --- | --- |
| `boss_watch_job_list` | 本地 SQLite 中已捕获的 JD | 无 |
| `boss_watch_job_get` | 一个 JD 的正文、哈希和 artifact 引用 | 无 |
| `boss_watch_application_timeline` | 一个投递的追加式事件 | 无 |
| `boss_watch_application_overview` | 一个投递的进度、事件和待提议状态摘要 | 无 |
| `boss_watch_application_list` | 本地投递表最新进度摘要 | 无 |
| `boss_watch_follow_up_list` | 本地跟进收件箱，合并最新 application 时间线 | 无，每次从 SQLite 刷新 |
| `boss_watch_follow_up_schedule` | 为已有 application 设置本地跟进时间和原因 | 只写本地 SQLite |
| `boss_watch_follow_up_complete` | 完成本地跟进提醒 | 只写本地 SQLite，不执行外部动作 |
| `boss_watch_apply_batch_prepare` | 从已核验候选创建有序本地批次 | 只写本地 SQLite |
| `boss_watch_apply_batch_status` | 批次状态、失败原因和 checkpoint | 无 |
| `boss_watch_apply_batch_resume` | 人工处理 handoff 后清除旧授权并回到等待确认 | 只写本地 SQLite，不执行外部动作 |
| `boss_watch_resume_import_preview` | 预览受控目录中的 PDF/DOCX/Markdown/TXT 简历及哈希 | 只读本地文件；不返回正文、不写 SQLite |
| `boss_watch_resume_import_apply` | 确认后创建不可变 ResumeVersion | 写内容寻址本地工件和 SQLite 元数据，不上传 |
| `boss_watch_resume_list/get` | 列出或读取简历版本元数据 | 无，不返回正文或绝对路径 |
| `boss_watch_resume_match` | 用本地 ResumeVersion 与已捕获 BOSS JD 做可解释匹配 | 只读本地工件；不返回正文、不调用模型、不上传、不授权投递 |
| `boss_watch_search_plan_preview` | 本地求职偏好 | 无；生成来源顺序和上限，不访问外部来源 |
| `boss_watch_growth_plan_preview` | 受控 Obsidian Markdown 文件名/标题 | 无；不返回正文、不写 Vault |
| `boss_watch_feishu_reconcile_preview` | 本地事实、投影和 Feishu 当前记录 | 无；只读对账，不采纳远端状态 |
| `boss_watch_apply_preview` | 已核验候选与已登记 ResumeVersion 的官网投递前预览 | 只读本地元数据；不打开官网、不读取简历正文、不填表、不提交 |
| `boss_watch_application_form_autofill` | 用户明确说“填当前页/继续填”后扫描当前 ATS 页，并一次填写确定性字段/下拉和上传 Gate A 简历 | 当前页一次性授权；个人值不进入结果，不勾选协议、不提交 |
| `boss_watch_application_form_preview` | 检查用户已打开的已核验官网/ATS 标准表单，并按本地简历证据分类字段 | 只读页面与本地简历；现有值脱敏，不导航、不填表、不上传、不提交 |
| `boss_watch_browser_status` | BossHunter Runtime、唯一 BOSS 岗位标签页和 Handoff 状态 | 无 |
| `boss_watch_discover_jobs` | 当前 BOSS 列表/搜索/推荐页的可见岗位卡片 | 无 |
| `boss_watch_capture_discovered_job` | 同一轮发现结果中用户选定的完整 JD | 临时详情页读取后写本地 SQLite并自动关闭 |
| `boss_watch_capture_current_job` | 当前唯一岗位详情页 | 只写本地 SQLite，不操作页面 |
| `boss_watch_capture_current_conversation` | 当前唯一 BOSS 聊天页中选中会话的最近招聘方消息 | 只写本地 SQLite；不回复、不点击、不发送 |
| `boss_watch_interview_note_preview` | 预览用户输入的面经与内容哈希 | 服务端短期内存，不写 SQLite |
| `boss_watch_interview_note_apply` | 用户确认后追加面经 Artifact/Event | 只写本地 SQLite，不访问外部平台 |
| `boss_watch_progress_signal_preview` | 预览粘贴的招聘通知或受控 `.eml/.txt`，提出面试/拒绝/offer/复核分类 | 本地规则与短期内存，不写 SQLite/飞书，不返回邮件正文 |
| `boss_watch_progress_signal_apply` | 用户确认 application、来源、哈希和提议后记录进度证据 | 追加本地 Artifact/Event；最多生成状态提议，不写飞书、不执行外部动作 |
| `boss_watch_watch_create` | 从已有本地 BOSS application 创建低频 JD Watch | 只写本地 SQLite，不打开页面、不立即 poll |
| `boss_watch_watch_list` | 查看已登记的本地 Watch 状态 | 无，不启动后台调度 |
| `boss_watch_watch_poll` | 对一个已到期 Watch 执行一次固定 URL 观察 | 受每日预算、间隔和人工 handoff 约束；可能读取详情页 |
| `boss_watch_watch_run_due` | 用户明确要求时执行一次到期 Watch 批次 | 最多 5 个、按时间排序、可取消；遇 handoff/失败/预算/占用停止，不启动后台循环 |
| `boss_watch_watch_stop` | 停止本地 Watch | 只写本地 SQLite |
| `boss_watch_watch_resume` | 用户处理 handoff 后恢复 Watch | 只写本地 SQLite，不自动 poll |
| `boss_watch_jd_diff` | 比较同一 application 的两版本地 JD Artifact | 只读，不打开页面、不调用模型、不写 SQLite；缺少基线返回稳定错误 |
| `boss_watch_lead_import_preview` | 受控导入目录中的 CSV/XLSX 预览 | 无，不访问腾讯文档 |
| `boss_watch_lead_import_apply` | 用户确认后的本地来源快照导入 | 只写本地 SQLite |
| `boss_watch_lead_clipboard_preview` | 预览用户从腾讯文档可见区域复制的 TSV/CSV | 只读本机剪贴板，不访问腾讯文档 |
| `boss_watch_lead_clipboard_apply` | 用户确认后的剪贴板来源快照导入 | 只写本地 SQLite；剪贴板变化则拒绝 |
| `boss_watch_lead_visual_preview` | DSH 持久截图附件和视觉结构化岗位行预览 | 重新读取附件计算哈希；不写 SQLite |
| `boss_watch_lead_visual_apply` | 用户确认来源、统计和低置信度后的截图快照导入 | 只写本地 SQLite；低置信度行不写入 |
| `boss_watch_source_status` | 本地来源快照状态 | 无 |

事实查询使用只读 SQLite 连接、参数化查询和稳定错误码。浏览器工具通过 4318 Controller 的本机服务身份
调用固定业务动作，不向模型暴露底层 CDP。数据库尚不存在或不可读时返回 `source_unavailable`；Runtime
断连返回 `environment_interrupted`；登录或验证返回 `human_required`。

简历目录默认是 `~/Library/Application Support/BossWatchAgent/resumes`，可用 `BOSS_WATCH_RESUME_DIR`
覆盖。DSH 工具只接受目录内的文件名，不接受绝对路径。确认导入后，内容寻址工件位于该目录的
`.artifacts/` 子目录；文件内容不会写入 SQLite 或工具结果。

插件的 `dsh.client` 半部分会在输入栏增加“导入简历”按钮和招聘进度信号回形针按钮。PDF/DOCX/Markdown/TXT 既可用按钮选择，也可把单个文件直接粘贴或拖入 DSH 输入区。简历客户端向 4318 本机 API 申请 10 分钟短期上传
会话，最多保留 32 个活跃会话，单文件上限 20 MiB、单会话最多 20 次上传尝试，只接受
PDF/DOCX/Markdown/TXT；暂存完成后仅将绑定内容哈希的预览请求追加到 DSH 草稿，不覆盖已有输入，
也不自动发送或 apply。默认只接受 `http://127.0.0.1:3080`，自定义 DSH 端口时同时设置
`BOSS_WATCH_DSH_WEB_ORIGINS`（逗号分隔的精确本机 Origin）；兼容的单值变量是 `BOSS_WATCH_DSH_WEB_ORIGIN`。默认同时允许稳定版 `http://127.0.0.1:3080` 和 rc.8 验证版 `http://127.0.0.1:3081`，不使用通配符。自定义 4318 地址可在页面启动前设置 `globalThis.__BOSS_WATCH_API_ORIGIN__`。

进度信号按钮只接受 `.eml/.txt`，单文件上限 2 MiB。招聘官网或 ATS 的权威状态通常仍需登录查询；
邮件分类只是本地证据和待确认状态提议，不能证明官网当前状态。需要投影到 Feishu 时，仍要另走
`boss_watch_feishu_sync_preview/apply`，不会因进度信号 apply 自动写入外部表格。

## Codex 与 DSH 如何配合

1. Codex 修改 `boss-watch-agent` 的领域代码或 `packages/dsh-plugin` 的工具契约。
2. DSH Web 从本地源码 checkout 启动，验证 Agent Loop、Tool 和 Web profile。
3. 插件通过 `dsh.bundle` 接入 Host 工具；浏览器事实仍由 `boss-watch-agent` 校验并写入 SQLite。
4. 每次改动分别运行业务仓库测试和插件/DSH smoke test。

当前 `dsh.client` 已提供求职中心按钮和 `shell.overlay`，内嵌同源 `/boss-watch/` 工作台；岗位池、匹配、Gate A、
人工确认进度、Feishu 投影和下一步也可继续通过 DSH 工具读取。简历导入使用独立输入栏按钮。已实现的浏览器能力包括岗位卡片发现、
受控详情打开、状态检查、当前岗位读取、选中会话招聘方消息读取、显式单次 JD Watch 和一次性到期批次；Watch 尚无常驻后台 Scheduler。
官网投递已支持哈希绑定 Gate A、`leadId + gateAId` 准备预览，以及对用户手工打开、与已核验链接同源的唯一官网/ATS 页做标准表单脱敏预览。Agent 可先一次确认本地候选人偏好，再通过受 session、Gate A 和 form hash 约束的一次性 Tool 批量预填确定性字段，并向唯一可用文件控件上传 Gate A 绑定的简历；姓名、邮箱、手机号和微信只在本机使用，不进入工具结果。登录、验证码、风控、证件/健康/政治字段、隐私同意项、跨页继续、消息发送和最终提交仍由用户处理。面经使用文本 preview/apply 归档；招聘进度支持文本信号提议和用户人工状态 preview/apply，两者不能混为最终事实。DSH 原生聊天附件仍只支持 PNG/JPG/WebP/GIF；求职插件通过按钮、单文件粘贴或拖拽把 PDF/DOCX 暂存到受控目录。`boss_watch_resume_match` 会在插件本机完成文本提取和规则匹配，不依赖模型上传。

跟进收件箱是请求时刷新，不是 BOSS 或飞书推送。提醒的完成只表示本地待办已处理，不改变追加式投递事实。

本地匹配基线可独立运行：

```bash
cd $BOSS_WATCH_DIR/packages/dsh-plugin
npm run eval:resume-match
```

报告只包含 case ID、标签、预测集合和聚合指标，不包含 Gold 中的 JD/简历正文。当前 10 个虚构固定场景
用于回归 `local-evidence-match-v3`，不能作为生产准确率或真实候选分布结论。

页面支持和后续 Feishu/action 插件边界见 [DSH 求职插件架构与页面支持矩阵](dsh-plugin-architecture.md)。

## 边界

- 不自动修改 DSH 上游 `master`；
- 不把本地 cookies、token、简历或真实聊天复制到 DSH checkout；
- 不通过 DSH Web 绕过登录、验证码或平台风控；
- 发送消息、投递简历、接受面试和飞书写入仍需单独的人工审批设计。
