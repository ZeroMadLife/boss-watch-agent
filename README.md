# Boss Watch Agent

[![CI](https://github.com/ZeroMadLife/boss-watch-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/ZeroMadLife/boss-watch-agent/actions/workflows/ci.yml)

这是一个以 DeepSeek Harness（DSH）为交互与 Agent Runtime、以本地事实账本为核心的求职盯盘 Agent。

DSH 通过独立插件调用受控 Browser Controller；Controller 复用 BossHunter CDP Runtime 连接用户已登录的
Chrome，只允许检查浏览器状态和捕获当前唯一岗位详情页。迁移决策见 [DSH 采用决策](docs/dsh-adoption-decision.md)。
原 Pi/Side Panel 路线继续保留，用于对话分析、页面适配器调试和故障回退。

当前版本已提供 DSH Web 工具、从零开始的本地 workspace overview、Browser Controller、Chrome Side Panel、岗位与招聘方消息只读捕获、面经和招聘进度信号 preview/apply 归档、SQLite
证据日志、本地投递跟踪表、GankInterview 校招候选快照、腾讯 CSV/XLSX 本地导入、查看权限下的剪贴板快照导入、来源快照与观察历史、基于内容哈希的人工 URL/JD 核验、受控 ResumeVersion 目录、有序批次计划/checkpoint、JD Watch 本地状态机与显式单次观察/到期批次、只读 JD Diff、官网投递 Gate A 预览、规则分析和导出。它不会自动发送消息、投递简历、
接受面试或处理验证码。

## Runtime 组合

- DSH Web 是当前交互与 Agent Runtime，业务能力通过 `packages/dsh-plugin` 注入，不修改 DSH 上游源码。
- Browser Controller、SQLite 和审批边界属于本仓库；DSH 只看到固定业务工具，不能获得任意 CDP/Playwright 权限。
- `@earendil-works/pi-*` 保留为早期对话分析基线与回退实验，不是当前网页编排主链路。
- 模型 Provider 与业务工具解耦；页面文本、模型输出和 Skill 文档都不能授予外部动作权限。

## 当前执行链

```text
DSH Web -> boss-watch-dsh-plugin
  -> authenticated localhost Browser Controller
  -> BossHunter CDP Runtime -> logged-in Chrome
  -> fixed BOSS Page Adapter + Guard
  -> SHA-256 verified local artifact
  -> append-only application event (JD / message / interview note / progress signal)
  -> one SQLite transaction
  -> DSH facts / user-triggered JSON or Markdown export
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
npm install
npm test
npm run check
npm run build
npm run serve
```

`npm run serve` 会自动创建仅供本机 DSH Host 使用的服务凭据：
`$HOME/Library/Application Support/BossWatchAgent/dsh-service-token`。文件权限为 `0600`，内容不会打印到
终端或进入 DSH 会话。Chrome 扩展仍使用独立配对机制，但 DSH 岗位捕获不需要配对码。

本地 DSH Web 平台可以从独立的上游源码 checkout 启动。按文档安装
`boss-watch-dsh-plugin` 后，除本地事实查询外，模型还可调用 `boss_watch_browser_status`、
`boss_watch_capture_current_job` 和 `boss_watch_capture_current_conversation` 检查 Browser Runtime、保存当前唯一岗位详情页或选中会话中的最近招聘方消息；手工面经使用
`boss_watch_interview_note_preview` -> `boss_watch_interview_note_apply` 归档：

```bash
npm run dsh:dev
```

默认打开 `http://127.0.0.1:3080/`，可通过 `DSH_SOURCE_DIR` 和 `DSH_WEB_PORT` 切换源码路径与端口。模型调用前仍需要在 DSH 中配置可用模型。Browser Controller 不接受 target ID、URL、CSS 或 JavaScript，也不会点击、导航、填写或发送；多个岗位标签页、登录和验证码会停止并返回明确状态。详见
[DSH 本地协同开发](docs/dsh-local-development.md)。

在 DSH 中可直接说“查看本地投递跟踪表”，调用 `boss_watch_application_list`；它每次读取 SQLite 的最新
事件并显示岗位进度、最近事件和待确认状态。说“搜索 Agent 校招岗位”时调用
`boss_watch_lead_search`，结果先保存为 `source_only` 候选，不代表官网 JD 或已投递。
每次搜索只进行一次请求时刷新，并将 `new/unchanged/changed` 写入本地来源观察历史；
`boss_watch_lead_observation_list` 可以读取新增与变化，但不代表后台持续同步。腾讯文档有导出权限时先通过官方能力导出 CSV/XLSX；只有查看权限时，在页面选中可见表格区域并复制，再调用剪贴板预览和确认工具。
用户查看候选保存的链接后，可以依次明确调用 `boss_watch_lead_url_confirm` 和
`boss_watch_lead_jd_confirm`，把当前哈希的候选提升为 `url_verified`、`human_confirmed`。这两个工具只写本地
核验事实，不打开网页；来源内容变化会撤销旧核验，自动页面核验仍未实现。

### 从零开始

新用户可以先在 DSH 中说“开始找工作”或“今天从哪里开始”。DSH 会调用只读工具
`boss_watch_workspace_overview`，检查本地 Runtime、简历版本、岗位候选、已核验 JD、已捕获完整 JD 和
Feishu 目标是否就绪，并返回当前阶段与下一步。它不会因此自动访问 GankInterview、遍历 BOSS、读取文件、
上传简历或写入 Feishu。

岗位来源按用户选择路由，一次只走一条：已配置 GankInterview 时做一次请求时搜索；用户已登录 BOSS 时读取
当前可见列表；用户持有招聘汇总时导入 CSV/XLSX、剪贴板或当前视口截图。招聘汇总和 GankInterview 先生成
`source_only` 候选；BOSS 列表摘要需要捕获当前详情页后才形成完整 JD。两条路径都不能用列表摘要直接评分或投递。

腾讯文档岗位表有导出权限时，请先通过官方能力导出 CSV/XLSX，并放入本地导入目录：

```bash
mkdir -p "$HOME/Library/Application Support/BossWatchAgent/imports"
cp ./27届秋招汇总.xlsx "$HOME/Library/Application Support/BossWatchAgent/imports/"
```

然后在 DSH 中先说“预览腾讯表导入”，确认工作表、字段映射和行统计后再说“确认导入”。对应工具是
`boss_watch_lead_import_preview` 和 `boss_watch_lead_import_apply`；它们只在本机解析和写入 SQLite，
不会访问或写回腾讯文档。查询最近导入使用 `boss_watch_source_status`。

只有查看权限时，在腾讯文档中选中要导入的可见行并按 `Cmd+C`，然后在 DSH 中说“预览我刚复制的腾讯表”。
DSH 会调用 `boss_watch_lead_clipboard_preview`；确认来源和统计后再说“确认导入这次剪贴板快照”，调用
`boss_watch_lead_clipboard_apply`。剪贴板变化会要求重新复制和预览，系统不会读取腾讯文档私有接口或把完整剪贴板写进会话。

Canvas 页面无法复制时，可以把当前可见区域截图粘贴到 DSH。视觉子代理先输出结构化岗位行，随后
`boss_watch_lead_visual_preview` 只做哈希、字段、重复和置信度检查；确认接受/拒绝数量后才调用
`boss_watch_lead_visual_apply` 写本地快照。低置信度行不落库，成功写入的候选仍是 `source_only`，不代表官网核验或已投递。

要根据本地投递表安排跟进时，说“查看待跟进岗位”，调用 `boss_watch_follow_up_list`；它每次合并本地提醒
和最新 application 事件。明确给出 application、提醒时间和原因后，使用
`boss_watch_follow_up_schedule` 创建本地提醒；处理完后使用 `boss_watch_follow_up_complete` 关闭提醒。
这些操作不会自动联系招聘方，也不代表外部跟进已经完成。

招聘官网或 ATS 的权威状态通常需要登录，本项目不会尝试匿名绕过。用户可以粘贴招聘通知文本，或通过
DSH 输入栏的回形针按钮导入 `.eml/.txt`，再调用 `boss_watch_progress_signal_preview`。本地固定规则只会
提出 `interview`、`rejected`、`offer` 或 `needs_review`；确认 application、来源、内容哈希和提议后，才调用
`boss_watch_progress_signal_apply` 追加本地证据。普通收件回执、取消、改期和冲突保持人工复核；没有新消息
绝不自动推断为拒绝。飞书同步仍是独立的 preview/apply。

对已经保存过完整 JD 的岗位，可以说“为这个 application 建立 JD 盯盘”，调用
`boss_watch_watch_create`。它只登记本地 Watch，不立即打开页面；说“现在检查这个 Watch”时才会显式执行
一次 `boss_watch_watch_poll`；如果用户明确要求检查全部到期 Watch，则调用一次 `boss_watch_watch_run_due`，单次最多 5 个。
系统固定使用首次捕获的 BOSS 详情链接，Profile 串行、每天最多 20 次详情观察，内容变化/未变化/断连/登录或风控会分别记录状态。
当前没有常驻后台 Scheduler，不会在 DSH 中自动循环，也不会绕过
登录、验证码或平台风控；用户处理 handoff 后需明确调用 `boss_watch_watch_resume`。

如果岗位已经产生两版本地 JD Artifact，可以说“看看这个 JD 改了什么”，调用
`boss_watch_jd_diff`。它默认比较最近两个不同内容哈希，也可以指定工具已经返回的两个 hash；输出新增/删除段落和行号，
不访问网页、不调用模型、不覆盖原始 Artifact。只有一版时返回 `jd_diff_baseline_missing`。

已核验候选可以通过 `boss_watch_apply_batch_prepare` 生成有序本地计划，再用
`boss_watch_apply_batch_status` 查看岗位级状态和 checkpoint。`boss_watch_apply_batch_resume` 只在用户处理完
登录/验证码等 handoff 后清除旧授权并恢复等待确认，不会自动填写、重试或提交。

DSH Web 输入栏提供独立的“导入简历”按钮，可直接选择 PDF、DOCX、Markdown 或 TXT；回形针按钮用于
选择 `.eml/.txt` 招聘进度信号。按钮通过 4318
本机短期上传会话把文件暂存到受控目录，并只把文件名、SHA-256 和预览请求追加到当前草稿；不会覆盖已有输入、
自动发送或确认导入。用户检查后调用 `boss_watch_resume_import_preview`，再明确调用
`boss_watch_resume_import_apply`；内容被复制为本机内容寻址工件，SQLite 和 DSH Transcript 只保留版本元数据。
`boss_watch_resume_list/get` 不返回正文或绝对路径。DSH 原生聊天附件仍只接受 PNG/JPG/WebP/GIF，
PDF/DOCX 由上述求职插件按钮处理；也可以手工把文件放到
`$HOME/Library/Application Support/BossWatchAgent/resumes/` 作为备用路径。

对已经通过 BOSS 捕获的完整 JD，可以使用 `boss_watch_resume_match` 指定一个
`applicationId + resumeVersionId` 做本地匹配。插件只读取内容寻址简历工件，返回哈希、提取状态、技能命中/缺口、
硬约束状态和可解释分数，不返回简历正文、不调用模型、不上传内容；结果仍停在 Gate A，不代表允许投递。

准备官网投递时，先调用 `boss_watch_apply_preview`。它只接受当前内容哈希下已达到 `jd_verified` 或
`human_confirmed` 的候选以及已登记的 `resumeVersionId`，展示固定 HTTPS 官网链接、简历版本元数据、已知字段和
`form_schema_not_loaded` 缺失项，并返回 `requiresHuman=true`。这一步不打开官网、不读取简历、不填写表单、不发送或提交；
用户手工打开该已核验官网/ATS 页面后，可以调用 `boss_watch_application_form_preview` 只读识别可见的标准
`input`、`textarea` 和 `select`，并按“简历可提供、需用户补充、敏感、未知”给出脱敏分类。工具不接受任意 URL、
target、CSS 或 JavaScript，不返回已有字段值或 URL query/hash；登录、验证码、风控、不同源或多个同源标签页均
转为 handoff。字段填充、简历上传和最终提交仍未接入。

`npm run serve` 默认只监听 `127.0.0.1:4318`，数据库位于
`$HOME/Library/Application Support/BossWatchAgent/boss-watch.sqlite3`。当前未配置真实模型时，服务明确报告
`baseline_ready`；不会把规则分析显示为 Pi。

测试账号的完整安装和验收步骤见 [测试账号试用手册](docs/test-account-quickstart.md)。

## 本地 SQLite 与导出

Node 内置 `node:sqlite` 承载本地投递事件和原文工件。用户可以显式导出：

```bash
npm run export -- --db "$HOME/Library/Application Support/BossWatchAgent/boss-watch.sqlite3" --out ./exports/applications.json --format json
npm run export -- --db "$HOME/Library/Application Support/BossWatchAgent/boss-watch.sqlite3" --out ./exports/application.md --format markdown --application <application-id>
```

默认拒绝覆盖已有导出文件；确认覆盖时追加 `--force`。导出不会自动上传到飞书或其他服务。

## 文档

- [基础架构设计](docs/superpowers/specs/2026-08-14-boss-watch-agent-foundation-design.md)
- [测试账号 Side Panel 设计](docs/superpowers/specs/2026-08-14-boss-watch-side-panel-test-account-design.md)
- [测试账号试用手册](docs/test-account-quickstart.md)
- [MVP 交付计划](docs/superpowers/plans/2026-08-14-boss-watch-agent-foundation-delivery.md)
- [评测与上线门槛](docs/evaluation.md)
- [DSH 采用决策](docs/dsh-adoption-decision.md)
- [DSH 本地协同开发](docs/dsh-local-development.md)
- [DSH 求职插件架构与页面支持矩阵](docs/dsh-plugin-architecture.md)
- [Job Search Agent Spec](docs/job-search-agent-spec.md)
- [Learn DSH with a Job Agent 学习博客方案](docs/learn-dsh-job-agent-outline.md)
- [Tool Runtime 与业务事件边界](docs/tool-runtime.md)
- [M3 JD Watch 交付计划](docs/superpowers/plans/2026-08-18-jd-watch-delivery.md)
- [本地 SQLite、导出与飞书投影设计](docs/local-storage-and-export.md)
- [真实账号与演示边界](docs/demo-account-boundary.md)
- [BOSS 对话 Skill](skills/boss-conversation-watch/SKILL.md)
- [安全报告](SECURITY.md)

## 仓库关系

```text
earendil-works/pi
  -> ZeroMadLife/pi                    # 现有 Pi 学习与通用实验 fork

deepseek-ai/deepseek-harness
  -> 本地源码学习 / 必要时上游 PR     # 不承载 BOSS 业务

ZeroMadLife/boss-watch-agent           # BOSS 领域事实与安全边界
  -> 当前 pinned @earendil-works/pi-* dependencies

packages/dsh-plugin                    # 业务仓内的 DSH 插件包
  -> 已接入本地投递跟踪、GankInterview 候选、腾讯表导入、人工 URL/JD 核验和 BOSS 浏览器工具
  -> dsh.client 岗位面板尚未实现
```

除非发现必须修改 Agent Runtime 的通用问题，否则业务代码不进入 Pi 或 DSH fork。DSH 更新时先在官方 clone
验证兼容性，稳定运行环境使用最后验证通过的 DSH commit。CI 当前固定验证
`deepseek-harness@47f943859bef60e4160492346772ded9b24f765a`；升级该值前必须通过根项目和插件完整门槛。

## License

[MIT](LICENSE)
