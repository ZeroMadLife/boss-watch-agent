# DSH 求职插件架构与页面支持矩阵

日期：2026-08-17
状态：BOSS 当前页与固定关键词搜索切片已实现；候选面板、M3 Watch 本地核心、一次性到期批次、结构化 Diff、招聘方消息捕获和面经归档已实现，待真实账号低频观察验收

文档命令使用可移植的业务仓变量：

```bash
export BOSS_WATCH_DIR=/path/to/boss-watch-agent
```

## 结论

DSH 作为编排层，业务能力拆成独立插件。`boss-watch-agent` 仍是事实账本和浏览器观察边界，不把 Cookie、验证码或未经批准的外部动作交给模型。

```text
DSH Web Agent
  -> boss-watch-dsh-plugin
       ├─ facts: job_list / job_get / timeline / overview / jd_diff
       ├─ resume: resume_import_preview / resume_import_apply / resume_list / resume_get
       ├─ application: apply_preview (verified lead + registered resume, Gate A)
       ├─ browser: browser_status / discover_jobs / boss_search_preview+run / capture_discovered_job / capture_current_job / capture_current_conversation
       ├─ candidate: workspace_overview / candidate_board
       ├─ interview: interview_note_preview / interview_note_apply
       ├─ progress: progress_signal_preview / progress_signal_apply
       ├─ watch: watch_create / watch_list / watch_poll / watch_run_due / watch_stop / watch_resume
       └─ Skill: boss-watch-job-search
  -> 4318 Browser Controller
  -> BossHunter CDP Runtime
  -> 用户已登录的 Chrome
  -> 固定 BOSS Page Adapter + Guard
  -> SQLite 事实账本

可选的后续插件
  ├─ boss-watch-dsh-feishu：Feishu CLI 预览、审批和投影
  └─ boss-watch-dsh-actions：需要人工确认的浏览器动作
```

DSH Transcript 只记录 Agent 的观察和工具调用，不替代 SQLite 事实。Skill 负责告诉模型何时调用只读工具和何时停在人工确认；工具负责 schema、数据访问和副作用边界。

## 当前插件

路径：`$BOSS_WATCH_DIR/packages/dsh-plugin`

| 能力 | 形态 | 当前状态 |
| --- | --- | --- |
| 岗位列表 | Host tool `boss_watch_job_list` | 已实现，只读 SQLite |
| JD 详情 | Host tool `boss_watch_job_get` | 已实现，只读 SQLite |
| 投递时间线 | Host tool `boss_watch_application_timeline` | 已实现，只读 SQLite |
| 投递进度概览 | Host tool `boss_watch_application_overview` | 已实现，只读 SQLite 派生摘要 |
| 本地投递跟踪表 | Host tool `boss_watch_application_list` | 已实现，每次调用读取最新 SQLite 事实 |
| 本地跟进收件箱 | Host tools `boss_watch_follow_up_list/schedule/complete` | 已实现；提醒与 application 事实分表，本地写入不触发外部动作 |
| 有序批次计划 | Host tools `boss_watch_apply_batch_prepare/status/resume` | 已实现本地状态与 checkpoint；不包含外部提交 |
| 本地简历版本 | Host tools `boss_watch_resume_import_preview/apply/list/get` | 已实现；受控目录、哈希复核、内容寻址工件和 SQLite 元数据，正文不进入 Transcript |
| 官网投递前预览 | Host tool `boss_watch_apply_preview` | 已实现 Gate A；绑定已核验 JobLead 和已登记 ResumeVersion，不打开官网、不读取简历正文、不填表、不提交 |
| Feishu 字段预览 | Host tool `boss_watch_feishu_preview` | 已实现，只读；不调用 Feishu |
| 浏览器状态 | Host tool `boss_watch_browser_status` | 已实现，不操作页面 |
| 岗位卡片发现 | Host tool `boss_watch_discover_jobs` | 已实现，只读当前列表页 |
| BOSS 关键词搜索 | Host tools `boss_watch_boss_search_preview/run` | 已实现；固定关键词/城市、最多 2 页/5 个岗位，跨页去重、详情串行捕获，登录/验证/风控/断连 handoff |
| 统一候选面板 | Host tool `boss_watch_candidate_board` | 已实现；并列展示 Gank/Tencent 来源候选与已捕获 BOSS JD，不模糊合并、不刷新来源 |
| 发现结果捕获 | Host tool `boss_watch_capture_discovered_job` | 已实现，临时详情页读取后自动关闭 |
| 当前岗位捕获 | Host tool `boss_watch_capture_current_job` | 已实现，只写本地 SQLite |
| 当前会话捕获 | Host tool `boss_watch_capture_current_conversation` | 已实现，只读取唯一选中会话最近招聘方消息；不回复、不发送 |
| 面经归档 | Host tools `boss_watch_interview_note_preview/apply` | 已实现，短期 preview token + 明确确认后追加本地 Artifact/Event |
| 招聘进度信号 | Host tools `boss_watch_progress_signal_preview/apply` + `dsh.client` 回形针按钮 | 已实现粘贴文本和 `.eml/.txt` 本地分类；确认后只追加本地证据/状态提议，不自动写飞书 |
| JD Watch | Host tools `boss_watch_watch_create/list/poll/run_due/stop/resume` | 已实现本地状态机、每日 20 次预算、显式单次 poll、最多 5 个的到期批次、取消、停止和人工暂停；无常驻后台 Scheduler |
| JD Diff | Host tool `boss_watch_jd_diff` | 已实现本地 Artifact 历史的有界新增/删除段落比较；只读派生，不覆盖原文 |
| 求职工作流约束 | Skill `boss-watch-job-search` | 已实现，按需加载 |
| 腾讯 CSV/XLSX 导入预览 | Host tool `boss_watch_lead_import_preview` | 已实现，只读本地文件 |
| 腾讯 CSV/XLSX 导入应用 | Host tool `boss_watch_lead_import_apply` | 已实现，写本地快照和观察 |
| 腾讯截图视觉预览/应用 | Host tools `boss_watch_lead_visual_preview/apply` | 已实现；绑定 DSH attachment 哈希、短期 token 和显式确认，低置信度行不落库 |
| 来源快照状态 | Host tool `boss_watch_source_status` | 已实现，只读 SQLite |
| 简历导入按钮 | `dsh.client` + 4318 本机上传会话 | 已实现；不改 DSH 原生图片附件协议，暂存后仍需 preview/apply 确认 |
| Feishu 多维表格投影 | Host tools `boss_watch_feishu_target_preview/confirm` 与 `boss_watch_feishu_sync_preview/apply` | 本地事实、字段映射、CLI 写入和写后回查已实现；真实多条记录长期验收待完成 |
| BOSS/官网表单读取与发送 | 独立 action plugin | 未实现；当前仅有官网投递 Gate A 预览 |

Skill 通过 `ctx.skills.register()` 挂载；它不会自行执行工具，也不会把“用户想投递”当作授权。当前插件依赖 DSH profile 已有的 `skills`、`tools` 和 `system-prompt` 服务。

## 页面支持矩阵

以下矩阵来自 ego-lite 对真实 BOSS 页面 DOM 的观察，以及本地 Page Adapter 回归测试。页面状态不是对所有账号的 SLA；页面结构变化时必须回到 `page_adapter_mismatch`，不能把整页内容上传给模型。

| 页面 | 观察结果 | Browser Controller / Side Panel 行为 |
| --- | --- | --- |
| `/web/geek/jobs` 岗位列表 | 可加载职位卡片和链接 | `boss_watch_discover_jobs` 读取可见卡片；选定后临时打开详情页 |
| `/job_detail/<id>.html` 岗位详情 | 可读取岗位名、公司和 `.job-sec-text` JD | Controller `ready`，可保存岗位证据 |
| `/web/geek/chat` 未选会话 | 只有联系人列表，没有当前消息 | `application_required` 或等待选择 |
| `/web/geek/chat` 已选会话 | 实际 DOM 使用 `.friend-content.selected`、`.message-item.item-friend` | `ready`，读取最近一条招聘方消息 |
| 登录弹层 | 真实页面出现登录组件 | `human_required(login)`，交还人工 |
| 验证/CAPTCHA | 真实页面出现验证组件 | `human_required(verification)`，交还人工 |
| 公司页、未知路径、非 BOSS 域名 | 不属于当前捕获契约 | `unsupported` |

当前聊天适配器会排除 `.item-myself` 和 `.item-system`，避免把自己的消息或系统卡片当成招聘方消息。页面选择器回归覆盖了这两个真实类名。
DSH 原生聊天附件当前只接受 PNG/JPG/WebP/GIF 图片；求职插件输入栏按钮可选择 PDF/DOCX/Markdown/TXT，通过 4318 本机短期会话暂存后生成 preview 草稿。面经走文本 preview/apply，不依赖原生附件。

招聘官网或 ATS 的权威投递状态通常需要登录，本插件不尝试匿名绕过。邮件/通知信号只能作为待确认的
本地证据；取消、改期、冲突和普通回执保持 `needs_review`，无消息不能推断为拒绝。

## Feishu 插件边界

下一条 Feishu 插件应保持三个层次：

1. `feishu_preview`：把待同步记录转换成字段映射和内容哈希，只读，不联网写入。
2. `feishu_approval`：把 `sessionId + recordId + contentHash + expiresAt` 绑定到一次明确确认。
3. `feishu_commit`：只接受未过期、未使用且哈希一致的审批令牌，调用本机 `lark-cli` 或受控 API；失败要返回稳定错误，不修改本地事实。

不会把飞书 token、Cookie 或本地 `.env` 打进 DSH profile，也不会让通用 Bash 工具绕过这层契约。飞书投影成功后只追加 `external_projection_succeeded/failed` 事件。

## 验收命令

```bash
cd $BOSS_WATCH_DIR
npx vitest run test/*.test.ts
npm run check
npm run build

cd $BOSS_WATCH_DIR/packages/dsh-plugin
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

DSH Web 需要在模型配置完成后才会真正调用工具。没有 SQLite 时事实工具返回 `source_unavailable`；
Browser Runtime 或 4318 服务不可用时浏览器工具返回 `environment_interrupted`，不生成虚构岗位。
