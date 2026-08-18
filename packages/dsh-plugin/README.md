# boss-watch-dsh-plugin

This package is maintained inside the `boss-watch-agent` repository. The local
DeepSeek Harness checkout is a development-only dependency and is not vendored
or copied into this repository.

DeepSeek Harness 的求职业务插件。当前版本提供本地事实查询和受控浏览器工具：

- `boss_watch_workspace_overview`：只读汇总当前闭环阶段、简历/候选/JD/Feishu 计数、可用来源和下一步；不刷新任何来源；
- `boss_watch_job_list`：列出已捕获 JD；
- `boss_watch_job_get`：查看单个 JD 原文和哈希；
- `boss_watch_application_timeline`：查看追加式投递事件；
- `boss_watch_application_overview`：读取本地投递进度概览。
- `boss_watch_application_list`：读取本地投递跟踪表；每次调用从 SQLite 刷新，展示所有岗位的进度摘要。
- `boss_watch_follow_up_list`：读取本地跟进收件箱，并与最新 application 时间线合并；
- `boss_watch_follow_up_schedule`：为已存在的 application 创建本地提醒，不执行外部动作；
- `boss_watch_follow_up_complete`：关闭一条本地提醒，不代表外部跟进已经成功；
- `boss_watch_lead_search`：只读查询 GankInterview 校招岗位并保存最小本地候选快照；不核验官网、不投递；
- `boss_watch_lead_list` / `boss_watch_lead_get`：读取本地候选池。
- `boss_watch_lead_observation_list`：读取本地来源观察历史；默认展示新增/变化，可选包含未变化刷新；不会访问外部来源；
- `boss_watch_lead_import_preview`：预览受控目录中的腾讯 CSV/XLSX 导出文件，不写岗位事实；
- `boss_watch_lead_import_apply`：用户确认后原子写入本地来源快照、当前事实和观察历史；
- `boss_watch_lead_clipboard_preview`：预览用户从腾讯文档可见表格区域复制到本机剪贴板的 TSV/CSV 快照，不写岗位事实；
- `boss_watch_lead_clipboard_apply`：用户确认后原子写入剪贴板来源快照、当前事实和观察历史；剪贴板变化会拒绝应用；
- `boss_watch_lead_visual_preview`：校验用户主动粘贴截图的 DSH 附件哈希和视觉结构化岗位行；不写岗位事实；
- `boss_watch_lead_visual_apply`：用户确认来源、统计和低置信度提示后写本地快照；低置信度行不落库，候选保持 `source_only`；

视觉导入会拒绝把包含 `...`/`…` 的截断招聘链接当作身份锚点；这类链接只产生 `truncated_channel_url` warning，岗位按结构化字段去重。
- `boss_watch_source_status`：只读最近成功导入的来源快照；
- `boss_watch_lead_url_confirm`：确认候选快照中已有的 HTTPS 链接，绑定当前内容哈希；不接受任意 URL，也不打开页面；
- `boss_watch_lead_jd_confirm`：在 URL 已确认后记录用户对公司、岗位和当前 JD 身份的明确确认；不自动识别或投递；
- `boss_watch_apply_batch_prepare`：按用户给定顺序创建本地批次；仅接受 `jd_verified` / `human_confirmed` 候选，不打开投递页。
- `boss_watch_apply_batch_status`：读取批次岗位状态、失败原因和 handoff checkpoint。
- `boss_watch_apply_batch_resume`：用户处理完 handoff 后清除旧授权并恢复到 `awaiting_gate_b`，不自动重试或提交。
- `boss_watch_resume_import_preview`：预览受控目录中的 PDF/DOCX/Markdown/TXT 简历，计算哈希但不返回正文；
- `boss_watch_resume_import_apply`：用户确认后复核哈希，写入内容寻址本地工件和 ResumeVersion 元数据；
- `boss_watch_resume_list` / `boss_watch_resume_get`：只读简历版本元数据，不返回正文或绝对路径；
- `boss_watch_resume_match`：使用 `local-evidence-match-v2` 在本机生成技能/硬约束证据和保守等级，不返回正文；
- `boss_watch_apply_preview`：绑定已核验 JobLead 和已登记 ResumeVersion，生成官网投递 Gate A 预览；不打开页面、不读取正文、不填表、不提交；
- `boss_watch_application_form_preview`：只读检查用户已打开且与已核验 JobLead 同源的唯一官网/ATS 页面，脱敏分类标准表单字段；不导航、不填表、不上传、不提交；
- `boss_watch_feishu_preview`：生成 Feishu 多维表格字段预览，不执行写入；
- `boss_watch_feishu_target_preview`：解析用户提供的 Feishu Base/Wiki 链接，读取表结构并生成字段映射预览；
- `boss_watch_feishu_target_confirm`：用户确认映射后保存本地 Feishu 目标配置，不写入 Feishu 记录；
- `boss_watch_feishu_sync_preview`：比较本地投递事实与目标表，展示 create/update/unchanged/conflict；
- `boss_watch_feishu_sync_apply`：用户确认精确预览后串行幂等写入目标表；schema、事实或映射变化会拒绝应用；
- `boss_watch_browser_status`：检查本地 BossHunter Runtime 和当前 BOSS 岗位标签页；
- `boss_watch_discover_jobs`：读取当前 BOSS 列表/搜索/推荐页的可见岗位卡片，不打开详情页；
- `boss_watch_capture_discovered_job`：在临时详情页打开上一条发现结果中明确选定的岗位，捕获后自动关闭；
- `boss_watch_capture_current_job`：读取当前唯一岗位详情页并写入本地 SQLite。
- `boss_watch_capture_current_conversation`：读取当前唯一 BOSS 聊天页中选中会话的最近招聘方消息；不回复、不点击、不发送。
- `boss_watch_interview_note_preview` / `boss_watch_interview_note_apply`：先预览用户手工输入的面经和哈希，明确确认后追加本地 interview_note Artifact/Event。
- `boss_watch_progress_signal_preview` / `boss_watch_progress_signal_apply`：预览粘贴文本或受控 `.eml/.txt` 招聘通知，明确确认后追加本地进度证据和可选状态提议；不写飞书、不执行外部动作。

同时注册 `boss-watch-job-search` Skill，指导模型按需使用只读工具并在外部动作前停在审批。
用户没有指定来源、只说“开始找工作”时，Skill 先调用 workspace overview，再让用户在 GankInterview、
BOSS 当前页、文件、剪贴板或截图中选择一条来源路径，不同时触发多来源读取。

岗位摘要使用 `salaryStatus=available|obfuscated|missing` 表示薪资字段质量。私有字体混淆时不返回
不可信 `salary`，Skill 只允许展示“薪资待人工核对”，不能由模型猜测数字。

浏览器工具通过 `boss-watch-agent` 的 4318 Browser Controller 调用固定页面提取器，不接受 target、任意 URL、
CSS 或 JavaScript。只有 `boss_watch_capture_discovered_job` 可以根据同一轮发现结果在临时页打开一个固定的
BOSS 岗位详情页；捕获后自动关闭，遇到登录或验证码则保留页面交给人工。当前不自动登录 BOSS、不填写表单、
不发送消息、不投递简历、不接受面试，也不写入飞书。Feishu 投影采用 `preview -> explicit apply`，第一版
只支持 SQLite 到 Feishu 的单向投影，失败不会改变本地事实。

简历文件默认从 `~/Library/Application Support/BossWatchAgent/resumes` 读取，或由
`BOSS_WATCH_RESUME_DIR` 指定。工具只接受目录内文件名，拒绝绝对路径、路径穿越和符号链接；单文件最大
20 MiB。SQLite 只保存版本元数据，内容寻址工件保存在该目录的 `.artifacts/` 子目录。
DSH 原生聊天附件目前只支持 PNG/JPG/WebP/GIF；插件在输入栏提供独立“导入简历”按钮，通过 4318
本机短期上传会话把 PDF/DOCX/Markdown/TXT 暂存到该受控目录，只生成预览草稿，不自动发送或 apply。
同一输入栏的回形针按钮只暂存 `.eml/.txt` 招聘进度信号，单文件上限 2 MiB；预览不返回邮件正文。
招聘官网/ATS 的权威状态通常仍需登录，邮件规则分类不能替代官网核验，也不会自动触发 Feishu 同步。

批量计划是本地状态模型：`queued -> awaiting_gate_b -> ready -> in_progress -> submitted_observed`，异常时进入
`failed` 或 `handoff_required`。当前版本已实现计划、状态、恢复和官网/ATS 标准表单的只读脱敏预览；真正的
Gate B 校验、字段填充、简历上传和最终提交仍未接入。
记录 Gate B 和开始岗位前都会重新核对批次保存的 `leadContentHash` 与当前候选快照；来源变化会返回
`lead_content_changed` 并保持原岗位停在等待状态，不会复用旧核验。

跟进提醒保存在同一 SQLite 的 `application_follow_ups` 表。列表工具每次调用都重新读取提醒和
`application_events`，所以能反映本地最新写入；这里的“实时”是请求时刷新，不是 BOSS/飞书推送，
也不是后台自动轮询。提醒原因和完成状态不会覆盖岗位事实或把 `status_change_proposed` 升级为已确认状态。

岗位核验采用两步本地状态机：`source_only -> url_verified -> human_confirmed`。确认工具只读取候选快照中
已经保存的 `channelUrl`，要求 HTTPS，并绑定调用时展示的 `contentHash`；来源刷新后内容哈希变化会清除旧
`officialApplyUrl`、退回 `source_only`，避免旧核验被新岗位内容复用。确认事实另存于
`job_lead_verifications`，重复确认同一 `leadId + contentHash + kind` 返回原记录。`jd_verified` 保留给后续
具有可审计页面证据的自动核验；当前两个工具不访问官网，也不证明链接仍在线。

来源不是持续同步。每次 `boss_watch_lead_search` 只拉取当前请求命中的 GankInterview 页面，并在同一 SQLite
事务中更新 `job_leads` 当前快照、追加 `job_lead_observations`。观察类型为 `new/unchanged/changed`；变化记录
旧 `contentHash`、旧 confidence 以及是否撤销过核验。完全相同的
`sourceKind + sourceRecordId + contentHash + fetchedAt` 重试幂等，A→B→A 的回退仍保留三次观察。
腾讯文档优先通过官方导出的 CSV/XLSX 按需导入；用户只有查看权限时，可复制可见表格区域后走剪贴板快照入口。
系统不访问私有接口、不后台轮询、不写回来源。当前
observation 历史也不反向伪造部署前的来源读取记录。

## 本地开发

本包使用业务仓旁边的本地 DSH checkout 进行类型检查和构建，`link:` 开发依赖只用于本地验证，`node_modules` 不应提交：

```bash
export BOSS_WATCH_DIR=/path/to/boss-watch-agent
export DSH_SOURCE_DIR=/path/to/deepseek-harness
```

```bash
cd $BOSS_WATCH_DIR
npm run dsh:plugin:check
npm run dsh:plugin:test
npm run dsh:plugin:build
```

安装到本地 DSH Web profile（需要先完成 `npm run build`）：

```bash
cd $DSH_SOURCE_DIR
DSH_HOME="$HOME/Library/Application Support/BossWatchAgent/dsh" \
  node --import tsx/esm apps/cli/src/bin.ts \
  plugin --profile web add $BOSS_WATCH_DIR/packages/dsh-plugin
```

如果要读取非默认数据库：

```bash
BOSS_WATCH_DB_PATH="/path/to/boss-watch.sqlite3" npm run dsh:dev
```

从 `boss-watch-agent` 执行 `npm run dsh:dev` 时，launcher 会优先读取 macOS Keychain 服务
`gankinterview-api-key`，只把密钥注入 DSH 子进程环境，不打印或落盘。也可以显式设置
`GANKINTERVIEW_API_KEY` 覆盖 Keychain；未配置时仅禁用 GankInterview 网络搜索，本地候选读取仍可用。

Browser Controller 默认读取：

```text
API: http://127.0.0.1:4318
Token: ~/Library/Application Support/BossWatchAgent/dsh-service-token
```

可通过 `BOSS_WATCH_API_ORIGIN` 和 `BOSS_WATCH_SERVICE_TOKEN_PATH` 覆盖；API origin 必须是 loopback HTTP。

运行 `npm run eval:resume-match` 可执行 9 个虚构 Gold/Badcase 回归。该结果只覆盖固定 fixture，不是生产准确率。

之后重启 DSH Web（`cd $BOSS_WATCH_DIR && npm run dsh:dev`），工具会出现在模型可用工具列表中；`dsh.client` 已在输入栏提供 PDF/DOCX/Markdown/TXT 简历选择按钮。
