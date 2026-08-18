# Job Search Agent Spec

日期：2026-08-18
版本：v0.19
状态：无 Side Panel 捕获主链路已通过测试账号验收；本地投递跟踪、跟进提醒收件箱、GankInterview 请求时快照及观察历史、腾讯 CSV/XLSX 导入、人工 URL/JD 核验、批次计划/checkpoint、受控 ResumeVersion 目录、招聘消息捕获、面经 preview/apply、招聘进度信号文本及 `.eml/.txt` preview/apply 已实现；JD Watch 的本地状态机、预算、显式单次 poll、人工暂停、一次性到期批次 Scheduler、本地结构化 JD Diff、本地 ResumeVersion-JD 可解释匹配和官网/ATS 标准表单只读脱敏预览已实现；自动官网核验、表单填充/提交、外部批量执行与真实账号 Watch 验收仍待完成

端到端闭环与 Feishu 单向投影的已确认设计见
[`2026-08-18 求职 Agent 端到端闭环设计`](superpowers/specs/2026-08-18-job-search-closed-loop-design.md)。

## 1. 目标

基于 DeepSeek Harness（DSH）开发一个面向个人求职的 Agent。第一阶段的核心不是自动投递，
而是把岗位、JD、招聘方消息、面试记录和投递进度收集为可追溯的本地事实，再由 DSH 进行查询、
汇总和下一步建议。

本 Spec 中“进度跟踪”指求职/投递进度，不指图片处理。

## 2. 产品边界

### 2.1 MVP 1.0 目标能力

- 由 DSH 通过受控 Browser Controller 观察用户已登录的 BOSS 页面；
- Browser Controller 只连接现有 Chrome 标签页，读取当前岗位列表和经用户选定的岗位详情；
- 将可见 JD、招聘方消息和面经以 SHA-256 证据写入本地 SQLite；
- 通过 DSH Skill 和只读 Host tools 查询岗位、详情、时间线和进度概览；
- 识别重复捕获、页面结构变化、来源不可用和待人工确认状态；
- 显式导出 JSON/Markdown，用户自行决定是否归档或同步；
- 支持用户从已核验岗位中批量选择并生成有序投递队列，逐岗位执行并显示失败项与人工接管状态；
- 为未来的 JD 盯盘、岗位变更和 Feishu 投影保留事件与幂等键。

### 2.2 明确不做

- 不自动登录、扫码、处理 CAPTCHA 或绕过 BOSS 风控；
- 不伪造浏览器指纹、破解验证码、滥用内部 API 或高频抓取；
- 未经逐岗位 Gate B 和聚焦测试，不自动发送消息、发送简历、接受面试或改变 BOSS 页面状态；
- 不在 MVP 1.0 自动生成或改写定制化简历；当前批次只引用用户明确选定的既有简历版本；
- 不把 BOSS 页面文本、模型输出或 Skill 文档当作工具授权；
- 不把 DSH Transcript 当作业务事实源；SQLite 仍是本地事实账本；
- 不把个人 SQLite 当作支撑大型招聘平台的共享任务队列。

## 3. 术语与事实等级

| 术语 | 定义 | 事实等级 |
| --- | --- | --- |
| JD | 岗位详情页中用户可见的岗位说明 | 原始证据 |
| Application | 一个本地投递跟踪实体，由平台和外部岗位 ID 稳定关联 | 本地事实索引 |
| Artifact | JD、招聘方消息或面经的不可变原文工件 | 原始证据 |
| Event | 对事实的追加式记录，如捕获、消息、面经或状态提议 | 可审计事实 |
| Proposal | 对状态的建议，不等于已完成的外部动作 | 待人工确认 |
| Overview | 从事件和工件只读聚合出的当前观察摘要 | 派生读模型 |
| Watch | 对已捕获 BOSS JD 进行低频、可停止的变化观察 | 本地状态机、显式单次 poll 和一次性到期批次已实现；无常驻后台调度 |

实现、已测量、设计中三类说法必须分开。固定测试账号上的通过结果不能包装成生产 SLA。

## 4. 运行时边界

```text
DSH Web（对话、Agent Loop、计划）
  -> packages/dsh-plugin（受控 Tools + Skill）
  -> 4318 Browser Run Controller（状态、预算、Guard、验证、Checkpoint）
  -> BossHunter CDP Runtime（固定浏览器原子能力）
  -> 用户已登录的 Chrome
  -> BOSS Platform Adapter（页面语义、固定提取器、风险识别）
  -> SQLite Application Event Journal（事实源）
  -> SQLite JobLead Snapshot（来源候选快照）
  -> 查询、JD Diff、评分和经批准的 Feishu projection
```

职责划分：

- `deepseek-harness`：独立 checkout，使用 `research/boss-watch-dsh` 分支学习和验证 DSH；只有通用修复才进入该仓库；
- `boss-watch-agent`：BOSS 观察、localhost API、SQLite、审批边界和导出；
- `packages/dsh-plugin`：DSH Host tools、Skill、来源导入、Browser Controller 客户端和未来的 DSH Client 页面；
- `ZeroMadLife.github.io`：DSH 学习文章、架构解释和经过审查的开发记录，不作为运行时依赖。

不把 DSH 源码复制进业务仓库，也不为 BOSS 选择器、岗位模型或飞书字段创建 DSH 长期 fork。
只有插件扩展点无法实现的通用能力、需要等待上游合并的修复或准备提交上游 PR 时，才在 DSH
专用分支产生改动。

Chrome Side Panel 降级为可选的页面适配器调试、人工检查和故障回退入口。日常 DSH 捕获、自动化
测试和后续低频 Watch 不依赖扩展配对或用户点击保存。

## 4.1 Browser Run Controller 原理

Controller 采用 Platform Watch 的通用执行思想，但不复制其企业级 Redis、Worker 和多租户能力：

```text
Run Contract
  -> 串行 ExecutionPlan
  -> 确定性 Browser Skill，必要时当前步骤回退 ReAct
  -> Fresh Capture
  -> ActionGuard
  -> 一个允许的浏览器原子动作
  -> Fresh Capture
  -> Goal Verification
  -> Event / Artifact
  -> Checkpoint / Handoff
```

第一阶段没有模型生成的任意 JavaScript、CSS 选择器或 URL。DSH 只能调用业务工具；Controller
持有固定页面提取器、`www.zhipin.com` 来源白名单和单次读取预算。登录、CAPTCHA 和风险页返回
`human_required`，浏览器断连或 Runtime 不可用返回 `environment_interrupted`。

岗位列表采用两阶段读取：`boss_watch_discover_jobs` 只读取当前列表、搜索或推荐页中可见的岗位卡片，
不写事实账本；用户明确选择一个发现结果后，`boss_watch_capture_discovered_job` 使用短期有效的
`discoveryId + externalJobId`，由 Controller 校验来源和岗位路径，再导航到固定详情页并复用详情适配器。
Controller 在临时详情标签页读取后自动关闭；遇到登录或验证则保留临时页交给用户。它不接受任意 URL、
target ID、CSS 或 JavaScript，也不执行点击、消息、投递或表单操作。

本机 DSH Host 使用自动生成且只保存在用户数据目录中的服务凭据访问 4318 Controller。凭据不打印、
不进入 DSH Transcript、不提交 Git；普通网页 Origin 和没有服务凭据的本机请求不能触发 Controller。

端口约定：`3000` 是 Astro 学习博客，`3080` 是 DSH Web，`4318` 是本地采集 API。

BossHunter `/health` 的 `connected` 字段是当前 WebSocket 的瞬时状态，不作为 Controller 的最终断连判定。
Controller 在 Runtime 身份正常时继续调用 `/targets`；该接口会主动建立 CDP 连接并返回页面。只有
`/targets` 请求失败，才返回 `environment_interrupted/browser_disconnected`。这样可以覆盖 Runtime
刚启动或连接空闲后由首次读取触发连接的正常恢复路径。

## 4.2 当前抓取链路

当前不是由 DSH 直接操作网页，也不是调用 BOSS 隐藏接口。实际链路是固定业务工具驱动的两阶段观察：

```text
用户要求查看当前列表
  -> DSH Skill 调用 boss_watch_discover_jobs
  -> DSH Plugin GET 4318 /api/v1/browser/jobs/discover
  -> Controller 调用 BossHunter Runtime /targets
  -> 选择唯一的 BOSS 列表/搜索/推荐页
  -> 在该页执行固定 JOB_LIST_INSPECTION_EXPRESSION
  -> 校验岗位 ID、www.zhipin.com URL 和字段质量
  -> 返回 5 分钟有效的 discoveryId + 岗位摘要
  -> 不打开详情、不写 SQLite

用户明确选择“第 N 个”或指定公司/岗位
  -> DSH 将本轮展示项映射为 externalJobId
  -> 调用 boss_watch_capture_discovered_job(discoveryId, externalJobId)
  -> Controller 校验 discovery 未过期且岗位属于本轮结果
  -> 只允许打开该岗位的固定 HTTPS 详情 URL
  -> 固定详情提取器读取公司、岗位名和 JD 原文
  -> 校验详情页 externalJobId 与选择项一致
  -> 计算 pageRevision，写入 SQLite Event + Artifact
  -> 相同幂等键和内容返回原 event
  -> 正常完成后关闭临时详情页
```

Side Panel 不参与这条主链路。DSH 不能传入任意 URL、target、CSS 或 JavaScript；“第 N 个”只是在
本轮 `jobs` 数组中选择已有 `externalJobId`，不是让模型自行拼接导航地址。遇到登录或验证时，临时页
保留给用户处理，Controller 不继续捕获也不写事实。

## 4.3 多来源岗位发现与归一化

岗位发现和岗位投递必须分成两个阶段：来源只负责提供可追溯的 `JobLead` 线索，投递前必须重新
核对公司招聘官网或 ATS 上的当前岗位。任何来源的摘要、推荐排序或内推码都不能直接授予投递权限。

### 4.3.1 `JobLead` 最小模型

```text
sourceKind          gankinterview_campus | tencent_smart_sheet | boss_visible | company_career_site
sourceRecordId      来源稳定 ID；没有稳定 ID 时只能使用 provisional ID
company             公司名称
role                岗位/方向原文
city                工作地点原文
cohort              招聘届别、实习/秋招等目标
deadline            截止日期或“招满为止”等原文
channelUrl          来源记录或公告链接
officialApplyUrl    已核验的官网/ATS 投递链接，可为空
sourceUpdatedAt     来源给出的更新时间
fetchedAt           本地读取时间
rawRef              本地最小原始证据引用，不默认复制整张外部表
contentHash         规范化线索字段的 SHA-256
confidence          source_only | url_verified | jd_verified | human_confirmed
```

### 4.3.2 已核对来源矩阵

| 来源 | 当前证据 | 产品角色 | 稳定性与限制 |
| --- | --- | --- | --- |
| GankInterview 校招接口 | 已验证 `GET /api/v1/campus`；支持分页、关键词/公司/地点/类型等筛选，返回 `gank_id`、`apply_url`、`announcement_url`、`source_updated_at`。2026-08-17 查询 `Agent` 返回 104 条总结果（仅证明命中，不证明适合本人） | 结构化发现源 | 由 Gank 聚合维护；必须打开并核验 `apply_url` 的当前官网岗位；`/interviews` 面试记录是另一类能力，不与岗位事实混用 |
| 腾讯智能表《27届提前批秋招汇总，offer收割机秘籍，持续更新》 | 公开只读可访问。`27届招聘每日更新` 页当日可见总数约 1151，字段包括企业、行业、招聘类型、开启时间、地点、岗位、投递链接；链接以招聘公众号文章为主。`27届内推企业` 页当日可见总数约 200，另有内推码，链接包含公司官网/ATS | 人工维护的发现与内推索引 | 表格主体由 Canvas 渲染，页面没有可依赖的稳定行 DOM ID；数量、列和内容会变；不能依赖内部接口或自动批量读取；内推码只作为用户查看的线索 |
| BOSS 可见列表/详情 | 已实现列表发现与指定岗位详情捕获 | 平台内发现和 JD 原文证据 | 受登录态、DOM 改版、薪资私有字形、风险页影响；仍需预算、串行和人工接管 |
| 公司招聘官网/ATS | 作为投递前的最终核验页面 | 权威投递入口与当前 JD | 页面结构各不相同；必须在用户请求下逐页读取，最终提交仍需 Gate B 和用户点击 |

腾讯表适配器采用两级降级：

1. 首选用户通过腾讯文档允许的导出能力提供 CSV/XLSX，系统在本地解析并保留文档 URL、sheet/view
   标识和读取时间；不把整张表上传到 DSH 或第三方模型。
2. 只有查看权限时，用户在公开页面主动选中可见表格区域并复制；插件只读取本机剪贴板的 TSV/CSV
   快照，先预览、再确认导入。它不做后台接口逆向、全表 Canvas 抓取或无人值守轮询。由于没有稳定行 ID，使用来源引用和规范化字段指纹生成的
   `provisionalSourceRecordId` 只能用于本次候选去重，不能当作永久来源 ID。

GankInterview 适合做第一版结构化候选池；腾讯表适合做人工维护的补充入口。两者都不替代官方
招聘系统，也不自动把来源中的岗位状态写成“已投递”。

当前已实现的 GankInterview 切片由 `boss_watch_lead_search` 发起只读 `GET /api/v1/campus`，把归一化的
`JobLead` 按 `gankinterview_campus + id` 幂等保存到 SQLite `job_leads` 表；`boss_watch_lead_list` 和
`boss_watch_lead_get` 只读本地快照。适配器通过 `GANKINTERVIEW_API_KEY` 接收运行时密钥，macOS launcher
会优先从 Keychain 服务 `gankinterview-api-key` 注入子进程；密钥不进入日志、Transcript 或数据库。候选的
`confidence` 初始只能是 `source_only`，`applyUrl` 只保留为 `channelUrl`，不会直接写入 `officialApplyUrl`。

这里的“刷新”是请求时刷新，不是后台同步：只有调用 `boss_watch_lead_search` 才会请求当前筛选页，未命中的
其他页不会被推断为删除或关闭。每条返回记录在更新 `job_leads` 当前快照的同一事务中追加一条
`job_lead_observations`：首次出现为 `new`，相同哈希的新读取为 `unchanged`，哈希变化为 `changed`。
`boss_watch_lead_observation_list` 默认只读 `new/changed`，可显式包含 `unchanged` 来核对最近刷新；它本身
不访问任何来源。历史从该表启用后的下一次来源读取开始，不回填或伪造部署前的请求记录。

腾讯文档第一版通过官方能力导出 CSV/XLSX 后导入本地受控目录。`boss_watch_lead_import_preview` 只解析文件、
展示字段映射和行统计；用户明确确认后，`boss_watch_lead_import_apply` 在一个 SQLite 事务中写入
`job_source_snapshots`、当前 `job_leads` 和有效行的 `job_lead_observations`。这仍是按需单向导入，不是后台
轮询，不写回腾讯文档；重复导入与 A -> B -> A 的幂等和历史规则见
[`M2.7 多来源岗位导入与快照设计`](superpowers/specs/2026-08-17-job-source-import-and-snapshot-design.md)。

查看权限场景已增加 `boss_watch_lead_clipboard_preview` 和 `boss_watch_lead_clipboard_apply`：前者只读取用户
刚复制到本机的可见表格区域，返回字段映射、统计和最多五行脱敏摘要；后者仍要求明确确认，并在剪贴板
哈希变化时拒绝应用。完整剪贴板内容不进入 DSH transcript；成功导入仍只是人工触发的本地快照。

### 4.3.3 去重、溯源与链接核验

去重顺序固定为：

1. `sourceKind + sourceRecordId`（Gank 的 `gank_id` 等稳定 ID）；
2. 规范化后的 `officialApplyUrl`；
3. 同一来源、同一公司/岗位/届别/地点字段的 `contentHash`。

公司名相同但岗位或链接不同不能自动合并；出现多个候选时返回人工确认。`channelUrl`、公告链接和
来源更新时间全部保留，官方链接只有在 HTTPS、主机名白名单和页面公司/岗位身份核验通过后才写入
`officialApplyUrl`。来源历史采用 `job_lead_observations` 追加观察，不覆盖已保存的 JD Artifact；每条观察保存
当前与前一 `contentHash`、前一 confidence、是否撤销核验和读取时间。精确重试使用
`sourceKind + sourceRecordId + contentHash + fetchedAt` 幂等，内容 A→B→A 仍保留三次观察。

当前人工核验切片提供两个本地写工具：

1. `boss_watch_lead_url_confirm(leadId, contentHash)` 只使用该线索已保存的 `channelUrl`，不接受模型传入的
   任意 URL；拒绝非 HTTPS、用户信息、非 443 显式端口、localhost、局域网域名和 IP 地址。用户必须已经
   查看页面并明确确认它是公司官网或 ATS 候选链接，才允许把快照提升为 `url_verified`。
2. `boss_watch_lead_jd_confirm(leadId, contentHash)` 只在 URL 已确认后使用；用户必须明确确认页面中的公司、
   岗位和当前 JD 身份一致，才把快照提升为 `human_confirmed`。它不执行自动页面识别，也不产生 Gate B。

两步都绑定当前 `contentHash`，并在 `job_lead_verifications` 保存幂等审计记录；同一
`leadId + contentHash + verificationKind` 重试返回原确认时间。相同内容的来源刷新保留现有最高置信度，
内容哈希变化则清空旧 `officialApplyUrl` 并退回 `source_only`。置信度只能单向提升；`url_verified` 仍不能
进入批次，`jd_verified` 保留给后续具有自动页面证据的核验实现。

### 4.3.4 Canvas/截图视觉降级

腾讯文档 Canvas、401 私有接口和剪贴板不可用时，视觉插件只能读取用户主动提供的当前视口截图，不能
绕过认证或恢复全表同步。候选插件和隔离联调证据见
[`DSH 视觉插件评估`](dsh-vision-plugin-evaluation.md)。视觉结果必须先进入
`boss_watch_lead_visual_preview`，再经用户确认调用 `boss_watch_lead_visual_apply`；它不直接授予岗位核验或投递权限。

当前实现只接受 DSH 本地持久附件引用，不接受 HTTP(S) 图片 URL。Host 从 attachment store 重新读取图片并
计算 SHA-256，preview token 同时绑定截图哈希、结构化岗位行和列映射，15 分钟后失效。缺少公司/岗位、
格式非法或置信度低于 `0.75` 的行只出现在预览拒绝列表；apply 仅把其余行以 `source_only` 写入现有
snapshot/observation 事务。同一截图的二次视觉抽取如果行内容不同，不会误用上一份 snapshot。
视觉模型输出的 `https://.../...` 截断链接也不会被当作可用来源：系统清空该链接并返回
`truncated_channel_url` warning，去重回退到公司、届别、招聘类型和岗位字段，避免不同公司因共享 URL 前缀被误合并。

## 4.4 岗位匹配与 Gate A

岗位匹配使用“先过滤、再核验、后评分”的顺序：

```text
来源筛选（届别/招聘类型/城市/关键词/截止状态）
  -> 用户选择候选
  -> 打开并读取官方 applyUrl 的可见 JD
  -> 固定字段和硬约束检查（学历、届别、地点、技术栈）
  -> 基于简历证据的语义匹配与缺口说明
  -> 输出匹配度、证据引用、不确定项和下一步
  -> 用户确认 Gate A，才进入材料准备
```

匹配结果必须同时展示证据来源和缺口，不能根据来源摘要、公司名或模型常识补全 JD。Gate A 只批准
“值得准备/值得投递”的岗位材料，不批准发送简历或提交表单；提交仍需单独的 Gate B。

当前已实现的第一版匹配只接受本地已经捕获完整 JD 的 `applicationId`，以及已经确认导入的
`resumeVersionId`。插件在本机校验工件哈希并提取文本：Markdown/TXT 直接读取，PDF 使用本机
`pdftotext`，DOCX 优先使用 macOS `textutil`，不可用时回退到 `unzip` 读取文档 XML。匹配策略为
`local-evidence-match-v2`，以固定技术词表、学历/届别/地点/经验规则生成命中、缺口、未知项和 0-100
分数；结果只返回哈希、计数、标签和风险，不返回简历正文或原始片段。正文提取失败、工件哈希不一致或
内容为空时失败关闭，不把“没有匹配到”解释成“简历不符合”。这不是模型语义理解，也不是生产筛选 SLA。

v2 在 v1 基础上增加保守门控：无可比技能或硬约束时返回 `insufficient_evidence`；任一硬约束不匹配时
等级最高为 weak、分数最高 49；硬约束缺少证据时等级最高为 moderate、分数最高 74；提取文本被截断时
始终返回 `insufficient_evidence`、分数最高 24。`本科及以上，硕士优先`按本科门槛处理，`Node.js` 中的
`js` 不再重复推断为独立 JavaScript 要求。

来源候选（GankInterview、腾讯快照或 BOSS 列表摘要）没有本地完整 JD 时不能直接评分；必须先完成
官方 JD 捕获/人工核验。匹配结果始终带 `requiresGateA=true`，不会授予消息发送、表单填写或投递提交权限。

### 4.4.1 DSH 聊天输入能力

DSH Web 原生聊天附件当前只覆盖下列图片媒体类型；求职插件另提供独立的“导入简历”按钮，不修改 DSH 图片附件协议：

| 输入 | DSH 聊天框 | 求职 Agent 处理路径 |
| --- | --- | --- |
| PNG/JPG/WebP/GIF | 支持 | 可交给视觉子代理做结构化预览；仍需用户核对后才写入事实 |
| PDF/DOCX 简历 | 原生附件不支持；求职插件按钮支持选择 | 暂存到本地受控 `resumes/` 目录，再生成 `boss_watch_resume_import_preview` 草稿；仍需用户发送并明确确认 apply |
| Markdown/TXT 简历 | 原生附件不作为依赖；求职插件按钮支持选择 | 同上，匹配时在插件进程内读取 |
| 面经文本 | 支持文本消息 | 走 `interview_note_preview/apply`，正文只在用户确认后进入本地事实账本 |

因此，不能把 PDF/DOCX 当作 DSH 原生图片附件发送给模型；按钮只负责本机受控暂存和生成预览请求，
不把简历正文放进 Transcript、模型请求或 SQLite。聊天附件能力只影响图片视觉降级，不改变本地简历和事实账本的主链路。

## 4.5 按需一键启动

个人用户最终不应手动打开三个终端。设计一个按需 macOS Launcher，幂等启动并健康检查：

```text
BossHunter Runtime :3456
  -> Boss Watch Controller :4318
  -> DSH Web :3080
  -> 健康检查全部通过后打开 DSH“求职中心”
```

Launcher 不设置开机自启动；端口已有正确服务时复用，端口被其他进程占用时明确失败，不杀死未知进程。
停止入口只关闭本 Launcher 启动且持有 PID 记录的进程。日志不得包含 Cookie、服务凭据、简历内容或
外部 API key。

## 5. 求职进度模型

### 5.1 目标端到端链路

以下是批准的 MVP 目标，不是当前已实现能力：

```text
Gank / 腾讯表 / BOSS / 公司官网发现 JobLead
  -> 基于官方 JD 和本地简历证据做匹配
  -> 用户选择候选岗位并确认准备顺序（Batch Application Run）
  -> 串行打开各官方投递页，生成最终字段/简历映射预览，不提交
  -> 用户在批次预览中逐行勾选“允许投递”
  -> 为每个获批岗位分别签发 Gate B，未勾选项不进入执行队列
  -> 按顺序填写并提交当前岗位获批的准确字段
  -> 读取当前页面成功/失败结果并追加 SQLite Event
  -> 成功则进入下一岗位；失败则记录失败原因并按策略继续或等待用户决定
  -> 批次完成后生成飞书多维表格投影预览
  -> 用户确认后幂等写入岗位、公司、投递时间和进度
  -> 后续跟进、面经归档、简历/JD 分析和模拟面试
```

MVP 1.0 将“准备批次”和“批准投递”分开。第一次选择只创建有序计划并生成各岗位最终预览，不授权提交；
用户看到公司、岗位、渠道、简历版本、字段映射、缺失项和风险后，可以在同一个批次页面逐行勾选。一次批量
确认可以为多行分别签发 Gate B，但每个授权仍绑定当前 session、公司、岗位、投递渠道、简历/字段内容哈希、
接收方、过期时间和一次 Submit。未勾选项、预览后发生内容变化的项、过期授权、历史批准或一句“帮我投一下”
都不能进入提交阶段。

### 5.2 批量投递队列模型

批量运行实体 `BatchApplicationRun` 只引用已通过 `jd_verified` 或 `human_confirmed` 的 `leadId`，至少保存：

- `batchId`、创建会话和创建时间；
- 用户确认的有序 `items`，每项包含 `leadId`、顺序和当前 `itemState`；
- 使用的简历版本、字段映射版本和批次级策略版本；
- 当前游标、最后一次结果、暂停原因和可恢复时间；
- 每个岗位独立的 Gate B 授权引用、内容哈希和过期时间；允许同一次用户确认签发多份授权，但不共享授权。

岗位级 `itemState` 使用以下值：

```text
queued
  -> awaiting_gate_b
  -> ready
  -> in_progress
  -> submitted_observed
  -> failed
  -> handoff_required
  -> skipped / canceled
```

`submitted_observed` 表示页面出现了可核对的成功证据，不表示平台一定已经完成后台处理；没有成功证据时
不能写成 `submitted`。批次状态由岗位状态派生：`queued`、`running`、`paused_handoff`、`completed`、
`canceled` 或 `completed_with_failures`。

执行顺序固定为用户确认的顺序，Profile 级并发保持 `1`。系统不会为了提高吞吐并行打开多个投递页面，也
不会因为某岗位失败而伪造成功或自动更换简历版本。用户可以在执行前或暂停时撤销尚未消费的岗位授权；
撤销后该项变为 `canceled`，不能继续提交。

### 5.3 失败与 Handoff

每个岗位的失败记录至少包含 `itemId`、阶段、稳定错误码、页面类型、最后证据时间、重试次数和建议动作；
不得把完整页面敏感内容写入日志。DSH 展示批次进度时必须能回答“第几个岗位、哪家公司、在哪一步失败、
是否需要人工处理、之后能否继续”。

处理策略分两类：

1. **岗位局部失败**：字段缺失、表单结构不匹配、岗位已关闭或提交结果不确定。该岗位标记 `failed`，
   保留现场摘要并默认暂停在队列游标处，由用户选择重试、跳过或结束批次；不能自动重复提交。
2. **会话/平台级 Handoff**：登录失效、验证码、风控页、`401/403/429`、浏览器断连或 Runtime 不可用。
   整个批次标记 `paused_handoff`，保存当前岗位和 checkpoint，交给用户处理；只有用户明确 resume 后才继续，
   且先重新 Fresh Capture，不复用过期页面或旧授权。

批次恢复必须是幂等的：已进入 `submitted_observed` 的岗位不会再次打开提交页；`failed` 岗位只有在新的
单岗位 Gate B 和新页面证据下才允许重试；`skipped` 岗位不会被隐式重新加入队列。执行 Submit 前必须再次
核对页面身份和字段内容哈希；与预览不一致则把该项转为 `handoff_required`，不能消费旧授权。

原始事件仍保持追加式，不覆盖历史。当前已支持的事件类型：

- `job_description_captured`：捕获 JD 和来源信息；
- `recruiter_message_captured`：捕获当前选中会话中招聘方可见消息；
- `interview_note_recorded`：用户记录面试内容；
- `progress_signal_recorded`：用户确认保存的招聘邮件、面试邀请、招聘方消息或人工状态证据；
- `status_change_proposed`：Agent 或用户提出状态变化，等待人工确认。

状态提议允许的生命周期值：

```text
discovered
  -> scored
  -> gate_a_approved
  -> material_prepared
  -> awaiting_gate_b
  -> submitted
  -> recruiter_replied
  -> interview_scheduled
  -> offer / rejected / no_response / closed
```

当前系统只把 `status_change_proposed` 作为提议展示，不能把它解释为已经提交、已经发送或已经
接受面试。进度概览使用以下安全的观察状态：

| `progressState` | 触发条件 | 含义 |
| --- | --- | --- |
| `new` | 只有 JD 事件 | 已发现岗位 |
| `conversation_active` | 存在招聘方消息 | 有可见沟通证据 |
| `interview_notes` | 存在面经事件 | 用户记录过面试材料 |
| `status_proposed` | 存在状态提议 | 有待确认的状态建议 |

### 5.4 本地跟进收件箱

本地投递表的“实时跟进”在 MVP 中定义为请求时刷新，不是 BOSS、官网 ATS 或飞书主动推送：

```text
用户明确为 application 设置跟进时间和原因
  -> application_follow_ups 保存本地提醒
  -> DSH 查询跟进收件箱
  -> 每次重新读取 scheduled 提醒
  -> 按 applicationId 合并最新 application_events 概览
  -> 展示到期顺序、最近事件和建议的人工下一步
  -> 用户明确处理完提醒后，将提醒标记 completed
```

提醒与投递事实分离。`application_follow_ups` 只保存 `applicationId`、到期时间、原因、短备注、创建时间和
完成时间；不会覆盖 `application_events`，不会把 `status_change_proposed` 升级成已确认状态，也不会因为
用户完成提醒就写成“已发送跟进消息”。列表按照 `dueAt` 排序，每次查询都重新合并最新事件，因此新增的
招聘方消息或面经能立即反映在下一次 DSH 查询里。

第一版提醒原因固定为 `application_status`、`no_response`、`interview` 和 `manual`。创建提醒只允许引用
已经存在的本地 `applicationId`；相同 `applicationId + dueAt + reason` 的重试返回原提醒。完成操作幂等，
只关闭本地待办，不访问浏览器、不联系招聘方、不写飞书。后台定时通知、系统推送和外部状态轮询不属于
本切片；后续 Watch 仍按第 7 节的低频预算和人工接管规则独立实现。

### 5.5 招聘消息与面经归档链路

M4 把“看到一条招聘方消息”和“用户记录一段面经”分成两条不同的证据链：

```text
BOSS 唯一聊天页
  -> Controller 识别 /web/geek/chat
  -> 只取当前选中会话最近一条非候选人、非系统消息
  -> applicationId 由用户/本地事实提供
  -> SQLite recruiter_message Artifact + Event（幂等）

用户手工输入面经
  -> interview_note_preview（服务端内存，15 分钟 token）
  -> 用户核对 application / interviewId / stage / contentHash
  -> interview_note_apply（confirmed=true）
  -> SQLite interview_note Artifact + Event（幂等）
```

消息捕获不接受任意 URL、target、选择器或脚本；多个聊天标签页、登录、验证码、风控和页面结构失配都交还人工。
面经 apply 不代表面试通过，也不改变外部平台状态。preview token 只绑定本次 application、面试 ID、阶段、原文哈希和过期时间，服务重启或过期后必须重新预览。

DSH Web 原生聊天附件仍只覆盖 PNG/JPG/WebP/GIF 图片；`boss-watch-dsh-plugin` 的 `dsh.client` 半部分在输入栏增加简历选择按钮。按钮通过本机 4318 API 的短期上传会话把 PDF/DOCX/Markdown/TXT 暂存到受控目录，然后把文件名、显示名和内容哈希作为不可信元数据生成 `boss_watch_resume_import_preview` 请求，并追加到已有草稿；用户发送后仍按 preview/apply 规则确认。面经优先使用文本输入；图片形式的面试白板或截图可先交给视觉子代理提取，再由用户把核对后的文字作为面经 preview 输入，不能把视觉输出直接当作事实。

### 5.6 免登录进度信号

官网/ATS 的权威申请状态通常依赖登录态，不能把匿名访问失败包装成“实时跟踪”。MVP 增加一条不绕过
登录的补充链路：用户主动提供招聘邮件、面试邀请、招聘方消息或人工核对结果，系统只在本地形成提议。

```text
粘贴通知文本，或由 DSH 输入栏暂存 .eml/.txt
  -> 核对唯一 applicationId
  -> boss_watch_progress_signal_preview
  -> 本地 MIME 解析 + 高精度固定规则
  -> 展示 sourceKind、source/content hash、outcome、confidence、reasonCodes
  -> 用户确认 application、来源、哈希和提议结果
  -> boss_watch_progress_signal_apply
  -> progress_signal Artifact + progress_signal_recorded Event
  -> interview/rejected/offer 追加 status_change_proposed
  -> needs_review 只保留证据，不生成状态提议
```

分类只允许 `interview`、`rejected`、`offer` 和 `needs_review`。取消、改期、类别冲突、普通收件回执或没有
高精度短语时必须返回 `needs_review`。`no_response` 不是文本分类结果，只能作为用户主动建立的跟进提醒；
时间经过、没有新邮件或官网不可匿名访问都不能推断为拒绝。人工状态更新必须显式使用 `manual_update` 和
用户声明的 outcome，不能由 Agent 代填。

`.eml/.txt` 通过 DSH 本机上传会话写入受控 `progress-signals/` 目录，单文件最多 2 MiB，文件名、扩展名、
常规文件和 SHA-256 会在服务端重新验证。MIME 由固定解析器处理，HTML 只转为分类文本；预览不回显邮件
正文，token 15 分钟失效。apply 只写本地 SQLite，不写飞书；如需同步仍走独立 Feishu preview/apply。

## 6. DSH 插件契约

### 6.1 已实现工具

| Tool | 作用 | 副作用 |
| --- | --- | --- |
| `boss_watch_job_list` | 列出本地 JD 摘要 | 只读 |
| `boss_watch_job_get` | 查看单个 JD 原文、哈希和 artifact 引用 | 只读 |
| `boss_watch_application_list` | 列出本地投递跟踪表的进度摘要；每次从 SQLite 刷新并按岗位取最新 JD 版本 | 只读 |
| `boss_watch_application_timeline` | 查看追加式事件时间线 | 只读 |
| `boss_watch_follow_up_list` | 读取本地跟进收件箱并合并最新 application 概览 | 只读，每次从 SQLite 刷新 |
| `boss_watch_follow_up_schedule` | 为已有 application 创建本地提醒 | 本地 SQLite 写入，不执行外部动作 |
| `boss_watch_follow_up_complete` | 完成本地提醒 | 本地 SQLite 写入，不声称外部动作成功 |
| `boss_watch_progress_signal_preview` | 预览粘贴文本或受控 `.eml/.txt`，本地提出面试/拒绝/offer/复核分类 | 只读本地输入和短期内存，不写 SQLite/飞书 |
| `boss_watch_progress_signal_apply` | 用户确认 application、来源、哈希和提议后记录信号 | 追加本地 Artifact/Event；最多生成状态提议，不执行外部动作 |
| `boss_watch_lead_search` | 只读搜索 GankInterview 校招接口并保存本地候选快照 | 外部只读 + 本地快照 |
| `boss_watch_lead_list` | 列出本地 `JobLead` 候选快照 | 只读 |
| `boss_watch_lead_get` | 查看单个候选的来源与核验字段 | 只读 |
| `boss_watch_apply_batch_prepare` | 从已核验候选创建有序本地批次；未核验候选整批拒绝 | 本地 SQLite 写入，不执行外部动作 |
| `boss_watch_apply_batch_status` | 读取批次、岗位状态、失败原因与 handoff checkpoint | 只读 |
| `boss_watch_apply_batch_resume` | 用户处理 handoff 后清除旧 Gate B 并回到 `awaiting_gate_b` | 本地 SQLite 写入，不重试、不提交 |
| `boss_watch_resume_import_preview` | 预览受控目录中的简历文件、哈希、大小和版本关系 | 只读本地文件，不写 SQLite，不返回正文 |
| `boss_watch_resume_import_apply` | 用户确认后保存 ResumeVersion 元数据和内容寻址工件 | 本地文件写入 + SQLite 元数据写入 |
| `boss_watch_resume_list` | 列出本地简历版本元数据 | 只读 |
| `boss_watch_resume_get` | 查看单个简历版本元数据 | 只读 |
| `boss_watch_apply_preview` | 为已核验候选生成官网投递前预览，展示简历引用、已知字段和缺失项 | 只读本地 JobLead；不打开页面、不读取简历、不填表、不发送、不提交 |
| `boss_watch_resume_match` | 用指定 ResumeVersion 与已捕获 BOSS JD 做本地可解释匹配 | 只读本地 JD/简历工件；不返回正文、不调用模型、不上传、不授权投递 |
| `boss_watch_application_form_preview` | 检查用户已打开的已核验官网/ATS 标准表单，并按本地简历证据分类字段 | 只读页面与本地简历；现有值脱敏，不导航、不填表、不上传、不提交 |
| `boss_watch_watch_create` | 从已有本地 BOSS application 创建低频 JD Watch | 本地 SQLite 写入，不打开页面、不立即 poll |
| `boss_watch_watch_list` | 读取已登记 Watch 的状态、预算计数和下次时间 | 只读，不启动后台调度 |
| `boss_watch_watch_poll` | 对一个已到期 Watch 执行一次固定 URL 观察 | 读取一个详情页并写本地观察；受 Profile 锁、日预算和 handoff 约束 |
| `boss_watch_watch_run_due` | 按 `nextPollAt` 执行一次到期 Watch 批次 | 显式调用、最多 5 个、可取消；遇 handoff/失败/预算/占用后停止，不启动后台循环 |
| `boss_watch_jd_diff` | 比较同一 application 的两版本地 JD Artifact | 只读派生结果；默认最近两个不同 hash，也可指定已存在的 hash，不访问网页、不写事实 |
| `boss_watch_watch_stop` | 停止一个 Watch | 本地 SQLite 写入，不打开页面 |
| `boss_watch_watch_resume` | 用户处理 handoff 后恢复 Watch | 本地 SQLite 写入，不自动 poll |
| `boss_watch_feishu_preview` | 生成飞书字段预览 | 只读，始终 `requiresApproval=true` |

工具名必须使用 `boss_watch_` 前缀。DSH 自带 `job_list` 是后台任务列表，禁止复用通用名称。

### 6.2 本切片新增工具

`boss_watch_application_overview`：

- 输入：`applicationId`；
- 输出：岗位摘要、`progressState`、`eventCount`、招聘方消息数、面经数、最近事件和待提议状态；
- 数据源：本地 SQLite，只读；
- 缺少数据库：返回 `source_unavailable`，不能返回伪造的空结果；
- 不执行网络访问、不打开 BOSS、不写飞书。

`boss_watch_application_list` 输出每个 application 的 `progressState`、事件数、招聘方消息数、面经数、
最近事件和状态提议，不返回完整 JD 正文。它是本地事件写入后的即时读模型，不代表外部平台主动推送或
已经完成实时轮询。

本切片同时实现 `BatchApplicationRun` 的本地持久化。`prepare` 保留用户选择顺序并只接受
`jd_verified` / `human_confirmed`；初始岗位状态是 `awaiting_gate_b`。状态存储支持 `ready`、
`in_progress`、`submitted_observed`、`failed`、`handoff_required` 和 `skipped`，但这些后续状态目前只供
未来 action adapter 在通过验证后写入，不代表 DSH 已具备外部投递能力。`resume` 只做 checkpoint 恢复：
清除旧授权并要求重新 Gate B，不打开页面、不重放 Submit。

本地跟进收件箱由三个工具组成：`boss_watch_follow_up_schedule` 只为已存在的 `applicationId` 建立提醒；
`boss_watch_follow_up_list` 每次合并提醒和最新 application 时间线；`boss_watch_follow_up_complete` 只完成
本地提醒。它们不访问外部平台，不自动发送消息，也不把提醒状态解释为投递状态。

`boss_watch_apply_preview` 是 M6 的 Gate A 垂直切片。它只接受当前内容哈希下已经达到 `jd_verified` 或
`human_confirmed` 的 `JobLead`，并要求该候选已有 `https` 官方/ATS 链接。简历必须使用已登记的
`resumeVersionId` 参与预览，服务只读取版本元数据，不读取引用对应的文件正文。输出包括规范化官网 URL、
公司/岗位/届别/招聘类型等已知字段、`form_schema_not_loaded` 缺失项、15 分钟过期时间和
`requiresHuman=true`。预览本身不访问网络、不启动浏览器、不写 SQLite；官网表单字段发现、辅助填充、最终提交
和结果验证仍属于后续切片，不能把该工具包装成自动投递。

`boss_watch_application_form_preview` 是 M6 的第二个只读纵向切片。它只接受已核验 `JobLead` 和已登记
`ResumeVersion`，工具参数不接受 URL、target、CSS 或 JavaScript。插件从本地 JobLead 取出固定
`officialApplyUrl`，Controller 只在用户已经打开的同源唯一 HTTPS 页面运行固定表单适配器；不导航、不点击、
不写 DOM。适配器只返回标准可见 input/textarea/select 的标签、类型、必填状态和“当前是否有值”，不返回
当前值；URL query/hash 也不进入 DSH 结果。插件在本机读取简历正文，只输出字段分类、来源可用性、哈希和
计数，不输出姓名、手机号、邮箱或简历原文。页面不同源、多标签页、登录、验证码、风控或未知表单返回
`handoff_required`。该预览始终为 `readOnly=true`、`externalAction=not_started`、`requiresGateB=true`，不代表
已经允许填写、上传或提交。

简历版本由 `boss_watch_resume_import_preview/apply` 管理。预览和应用只允许受控简历目录中的 PDF、DOCX、
Markdown 或 TXT；应用前会重新计算字节哈希，并把文件复制到内容寻址的本地工件目录。SQLite 只保存
`resumeVersionId`、显示名、`localArtifactRef`、内容哈希、媒体类型、大小、创建时间和可选的父版本引用；
正文不进入 SQLite、DSH Transcript 或外部来源。相同内容重复导入返回已有版本，源文件在预览后变化则拒绝应用。
`boss_watch_apply_preview` 只接受已登记的 `resumeVersionId`，并把 JD 哈希和简历哈希共同纳入预览身份。

`boss_watch_resume_match` 是第一版本地匹配切片。它只接受已经有完整 JD Artifact 的 `applicationId`，
读取指定 ResumeVersion 的内容寻址工件，返回 `local-evidence-match-v2` 的技能命中/缺口、硬约束状态、
分数、风险和哈希。结果不会保存为新的“已投递”事实，也不会自动写 Feishu；JD 或简历哈希变化后必须
重新匹配。对于扫描 PDF 或本机缺少提取工具的文档，工具返回稳定错误并交给人工处理，不调用视觉或模型补全。

M3 第一阶段新增六个 Watch 工具。`create` 只从 `source.getJob(applicationId)` 读取固定 BOSS URL 和当前
内容哈希，重复创建返回同一目标；`poll` 在 SQLite 事务内检查 Watch 状态、同一 Profile 互斥和每日 20 次
共享预算，再通过 Controller 执行一次观察。`run_due` 只做一次本地到期任务编排：按 `nextPollAt` 排序，默认
最多处理 5 个，向 DSH 的执行信号传递 cooperative cancellation，并在 handoff、短暂失败、Profile 占用或
预算耗尽时停止当前批次。它不创建常驻定时器，DSH 也不得自行循环调用它。其余工具只读或只改本地状态。

### 6.3 无 Side Panel 浏览器工具

| Tool | 作用 | 副作用 |
| --- | --- | --- |
| `boss_watch_browser_status` | 检查 BossHunter Runtime、BOSS 标签页和人工接管状态 | 只读，不执行页面动作 |
| `boss_watch_discover_jobs` | 读取当前 BOSS 列表/搜索/推荐页的可见岗位卡片 | 只读，不导航，不写库 |
| `boss_watch_capture_discovered_job` | 在临时详情页打开同一轮发现结果中的指定岗位并捕获完整 JD | 只读取已校验岗位并写本地 SQLite，完成后关闭临时页 |
| `boss_watch_capture_current_job` | 固定提取当前唯一岗位详情页并写入事实账本 | 只写本地 SQLite，不点击或导航 |
| `boss_watch_capture_current_conversation` | 读取当前唯一 BOSS 聊天页中选中会话最近一条招聘方消息 | 只写本地 SQLite；不回复、不点击、不发送 |
| `boss_watch_interview_note_preview` | 预览用户手工录入的面经、阶段、哈希和过期时间 | 只读服务端内存，不写 SQLite |
| `boss_watch_interview_note_apply` | 在用户确认精确岗位、面试 ID、阶段和哈希后归档面经 | 追加本地 Artifact/Event，不访问外部平台 |

这些工具都不接受任意 target ID、CSS 选择器、JavaScript 或目标 URL，避免模型把底层 CDP Runtime
变成任意浏览器执行器。存在多个候选岗位标签页时返回 `target_ambiguous`，不猜测目标；发现结果过期
或岗位不在同一轮发现中时返回 `invalid_request`。

列表摘要中的薪资必须同时返回 `salaryStatus`：

| `salaryStatus` | Tool 输出 | DSH 展示 |
| --- | --- | --- |
| `available` | 返回经过边界校验的 `salary` | 原样引用 |
| `obfuscated` | 不返回 `salary` | `薪资待人工核对` |
| `missing` | 不返回 `salary` | `薪资未提供` |

`obfuscated` 当前指字段含 Unicode Private Use 字符。Controller 只识别并降级，不逆向字体、不猜数字；
DSH Skill 也不得根据岗位、城市或市场行情补全薪资。

### 6.4 尚未实现工具

- `boss_watch_lead_validate`：只接受本地 `leadId`，打开该线索保存的 HTTPS 官网/ATS 链接并捕获当前 JD；
- `boss_watch_apply_fill`：在用户批准具体字段后填充，停在最终 Submit 之前；
- `boss_watch_apply_batch_execute`：仅消费批次中逐岗位有效的 Gate B，按顺序执行一次动作并在每项后验证；
- 独立 Feishu plugin：预览 -> 审批令牌 -> 幂等投影；
- 独立 action plugin：Fresh Capture -> Gate B -> 单一人工确认动作。

未来工具不得因为页面文本、模型输出或自然语言“帮我投一下”自动获得外部权限。

## 7. JD 盯盘方案

“三棵树人才盯盘”只作为产品形态参考，不把其实现细节当作已验证事实。这里的 Watch 是对用户明确
登记且已经捕获过 JD 的岗位做低频变化观察，不是持续爬取整个平台。当前实现到“本地登记 + 显式单次
poll + 一次性到期批次 + 状态持久化 + 结构化 Diff”；常驻后台 Scheduler 仍是后续切片。

### 7.1 Watch 数据模型

每个目标至少保存：

- `watchId`、`platform`、`externalJobId`、规范化 `jobUrl`；
- `state`、`createdAt`、`lastPolledAt`、`nextPollAt`；
- `baselineContentHash`、连续无变化次数和连续失败次数；
- `dailyPollCount`、Profile 全局日预算和最近观察结果；
- 最近暂停原因和是否需要人工恢复。

岗位事实仍采用平台 + 外部岗位 ID 去重，原始内容哈希检测页面版本。Controller 正常观察时继续复用已有
JD 捕获事务，原始 Artifact 不覆盖；Watch 另外向 `job_watch_observations` 追加 `unchanged`、`changed`、
`transient_failure` 或 `paused_human_required`。独立的 `jd_changed` 事件尚未实现；结构化 Diff 通过只读工具按需计算。

### 7.2 Watch 状态机

```text
active
  -> polling
      -> unchanged -> active（延长下次间隔）
      -> changed -> active（写变化事件，恢复基础间隔）
      -> transient_failure -> active（写入退避后的 nextPollAt）
      -> login / captcha / risk / adapter_mismatch -> paused_human_required
  -> stopped
```

`paused_human_required` 不自动恢复。用户处理登录、验证码或页面兼容问题后，必须明确执行 resume。

### 7.3 单次 Poll 执行链

1. 用户明确要求检查到期 Watch 时，调用一次 `boss_watch_watch_run_due`；Scheduler 从 SQLite 读取到期 Watch，
   按时间排序后最多处理 5 个，不由 LLM 自行循环，也不提供常驻后台定时器。需要只检查单个 Watch 时才调用
   `boss_watch_watch_poll`，工具自身执行 Risk Gate；
2. Risk Gate 检查 Profile 锁、日预算、最小间隔、暂停状态和 Runtime 健康；
3. 使用登记时保存的固定 BOSS 详情 URL 打开一个临时页；
4. 运行与手动捕获相同的 Fresh Capture 和来源校验；
5. 正常读取后立即关闭临时页；需要人工接管时保留页面并暂停 Watch；
6. 比较最新原始 Artifact `contentHash` 和 Watch 的 `baselineContentHash`；
7. 无变化只更新时间和计数；有变化保留 Controller 新捕获的 Artifact，并更新 Watch baseline。`boss_watch_jd_diff`
   从同一 application 的 Artifact 历史按 hash 生成有界的新增/删除段落；Diff 是派生读模型，不覆盖原文；
8. 根据结果计算 `nextPollAt`，不在同一轮立即重试。

### 7.4 保守初始预算

以下是 MVP 的保守默认值，不是“不会触发风控”的保证。当前显式单次 poll 和一次性批次 Scheduler 已实现
Profile 互斥、日预算和结果退避：

- 同一浏览器 Profile 并发固定为 `1`；
- 新建 Watch 允许用户显式进行首次观察；变化后下一次为 `12h`；
- 未来单批最多观察 `5` 个详情页，当前 Profile 全局每天最多 `20` 次详情观察；
- 首次无变化后等待 `24h`，连续无变化后延长为 `48h`，变化后恢复 `12h`；
- 网络或 Runtime 短暂失败从 `30min` 开始退避，不做紧邻重试；
- 登录、验证码、风险页、`401/403/429` 或 DOM 失配立即暂停，不消耗更多页面预算；
- 任务在时间上分散只为避免本机资源尖峰，不模拟人类轨迹，也不用于规避平台检测。

个人账号阶段不使用 Redis/Worker 并发抓取。以后即使引入队列，也只用于任务持久化、取消和恢复，
Profile 级信号量仍必须保持为 `1`。

## 8. 反爬信号与风险控制

### 8.1 当前证据

| 信号 | 当前事实等级 | 对数据的影响 | 系统响应 |
| --- | --- | --- | --- |
| 薪资私有字体字符 | 真实列表已复现 | 模型可能猜错薪资 | `salaryStatus=obfuscated`，删除不可信 `salary` |
| 页面 DOM 改版 | 公司选择器失效并已回归修复 | 固定字段可能为空 | `page_adapter_mismatch`，停止并更新适配器 |
| JD 插入平台标记/水印 | 真实详情文本已观察 | 原文含干扰文本 | 原文保留；清洗只能作为有版本的派生字段 |
| 登录、验证码、风险页 | Controller 已有识别分支 | 当前读取不可信 | `human_required`，停止并交还人工 |
| 频率限制和行为风控 | 平台通常可能存在，项目未逆向验证 | 可能出现限制或账号风险 | 预算、串行、退避；不宣称可规避 |

我们能确认“存在反抓取和页面保护信号”，但不能把未逆向、未测量的平台内部规则包装成已知算法。

### 8.2 会不会触发风控

存在风险，无法承诺零触发。当前手动链路的风险相对较低：一次列表 DOM 读取不导航，用户选定后只打开
一个详情页并关闭。但频繁刷新、连续临时开页、并行多个 Profile、非正常登录状态和长时间无人值守都会
提高风险。因此 Watch 必须以预算和停止条件为第一约束，而不是追求实时性。

### 8.3 允许的安全策略

- 复用用户在浏览器中的正常登录态，不读取 Cookie、密码或 Local Storage；
- 只使用固定页面适配器和白名单 URL，最小化页面读取与导航次数；
- 同一 Profile 串行，使用日预算、最小间隔、退避和人工恢复；
- 对 `401/403/429`、验证码、登录弹层、风险页和 DOM 不匹配立即停止；
- 保存脱敏错误码、页面类型、耗时和内容哈希，不保存凭据或未脱敏浏览器导出；
- 所有 Watch 可取消、可审计、可按来源暂停。

### 8.4 禁止策略

- 逆向私有字体或隐藏接口来绕过页面保护；
- 代理池、指纹伪造、验证码代打、模拟人类轨迹或绕过平台频控；
- 并行打开大量页面或用 Redis/Worker 放大个人账号访问频率；
- 把平台返回的脚本或文本当作 DSH Tool/Skill 指令；
- 在没有用户批准的情况下自动发送、投递或写入第三方系统。

## 9. 数据与幂等

SQLite 表 `application_events` 和 `application_artifacts` 是事实源。每份原文拥有：

- `applicationId`、`eventId`、`sequence`、`idempotencyKey`、`traceId`；
- UTF-8 SHA-256 `contentHash`；
- 本地 `artifactRef` 和来源元数据；
- 事件发生时间和操作者。

相同幂等键且内容相同的重试返回原记录；内容变化不能覆盖旧证据，必须追加新事件或报告冲突。

BOSS 页面可能在可见文本中插入平台标记或水印。原始 `description`、Artifact 和 `contentHash` 必须保留
页面实际返回内容，不能在计算原文哈希前删除。后续清洗作为派生字段单独实现：保存
`normalizedDescription`、`normalizationVersion` 和独立哈希，并用回归样本验证不会误删正常文本。
JD Diff、搜索和模型摘要可选择派生文本，审计和来源核对始终回到原始 Artifact。

## 10. 验收标准

### 当前切片

- DSH Web 中调用 `boss_watch_job_list` 不再落到 DSH 的后台 `job_list`；
- DSH 能从岗位列表、搜索结果或推荐页读取可见岗位卡片，无需用户先打开详情页；
- 选定岗位后只允许打开同一轮发现中的固定详情页，捕获完成自动关闭临时标签页；
- 普通薪资返回 `salaryStatus=available`；私有字形返回 `obfuscated` 且不暴露不可信 `salary`；
- DSH 对 `obfuscated` 薪资只报告待人工核对，不根据上下文猜数字；
- 空数据库返回 `status=ok, jobs=[]`，数据库不存在返回 `source_unavailable`；
- `boss_watch_application_list` 每次读取最新 SQLite 状态，按 `applicationId` 去重，不因旧 JD 修订占用列表窗口；
- 有 JD、消息和状态提议的 fixture 时，overview 的计数、最近事件和 `progressState` 稳定；
- GankInterview fixture 验证分页参数、Bearer 头、字段归一化、`source_only` 可信度、重复刷新和 `429` 降级；
- 来源观察区分 `new/unchanged/changed`，精确重试幂等，A→B→A 不丢历史，默认变更收件箱不包含 `unchanged`；
- 人工核验只接受快照中的 HTTPS 候选链接，必须按 URL 后 JD 的顺序单向晋级；重复确认幂等；内容哈希变化撤销旧核验；
- 批次 prepare 保留用户顺序，只接受 `jd_verified` / `human_confirmed`，失败时不产生半批数据；
- 批次记录 Gate B 和开始岗位前重新核对 `leadContentHash`；来源内容变化返回 `lead_content_changed`，旧批次不能复用旧核验；
- 批次状态能持久化失败原因和 handoff checkpoint；明确 resume 后清除旧 Gate B 并回到 `awaiting_gate_b`；
- Watch 只能从已有本地 BOSS application 创建，创建不打开页面、不立即 poll，重复创建保持幂等；
- Watch poll 只接受固定保存的 BOSS URL，遵守 Profile 串行、每日 20 次预算、12/24/48 小时区间和断连退避；
- Watch 在内容未变化、内容变化、短暂失败、登录/验证码/风控/适配器失配时分别写入可审计观察并返回稳定状态；
- Watch 遇人工 handoff 后保持暂停，只有显式 resume 才恢复，resume 不自动 poll；
- `npm run eval:resume-match` 对 9 个虚构 Gold 场景执行可重复评测，其中 6 个 Badcase；当前固定集要求
  技能抽取/命中 micro Precision、Recall、F1、硬约束准确率和等级准确率均为 1.0，原始 JD/简历不进入报告；
- PDF/DOCX 提取不可用返回稳定错误，超过 200,000 字符标记 `text_truncated`，不得据此输出 strong；
- 官网/ATS 表单预览只检查已核验链接同源的唯一已打开页面；不返回现有字段值或 URL query；登录、验证、风控、不同源、多标签页和未知表单失败关闭；
- 表单字段只能输出简历可提供、需用户补充、敏感和未知四类脱敏结论，姓名、手机号、邮箱和简历原文不进入工具结果；
- 插件测试、主项目类型检查和 lint 通过；
- 所有测试 fixture 使用虚构公司、岗位和 URL。

### 后续切片

- 腾讯表：公开只读页面可预览，CSV/XLSX 导入必须由用户提供；Canvas 页面不做全表私有接口抓取；
- 截图视觉导入：继续用真实的只读腾讯表当前 viewport 验收字段映射、重复截图和低置信度人工修正体验；
- 多来源去重：稳定来源 ID、官网 URL 和内容指纹分别有独立 fixture；公司同名不会误合并不同岗位；
- 自动岗位核验：只有具有可审计的官网/ATS 页面证据后才能提升为 `jd_verified`，摘要命中或 URL 可访问不等于核验通过；
- 重复捕获同一页面版本不追加重复事实；多个岗位标签页不自动选择；
- 登录、CAPTCHA、风险页和浏览器断连分别返回稳定的 Handoff 状态；
- 真实 BOSS 测试账号：岗位详情捕获可重复，重复保存不产生重复事实；
- 选中聊天会话：只保存招聘方消息，不把本人/系统消息当成招聘方消息；
- JD watch：常驻后台 Scheduler、跨进程 Profile 锁和真实账号低频观察验收；一次性到期批次、本地 Profile 锁与结构化 `boss_watch_jd_diff` 已实现；
- Feishu：预览、审批、哈希校验和幂等投影各自可测试；
- 任何外部 Action：有 session、recipient、content hash、expiry 的明确批准记录。
- 外部批量执行：最终预览后可一次逐行勾选多项并分别签发 Gate B；执行按岗位串行；失败项可定位、可跳过、
  可重新授权，页面变化或平台级风险必须 handoff。
- 官网投递 Gate A：已核验候选能生成固定 HTTPS 官网预览；预览包含简历引用、已知字段、缺失项、过期时间和
  `requiresHuman=true`，不会启动浏览器、读取简历、填写表单或提交。
- 官网/ATS 真实页面验收：对用户明确打开的一个真实只读页面核对标准控件覆盖、SPA 自定义字段降级和 handoff 体验；验收前不宣称支持该 ATS。

## 11. 里程碑

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M0 | DSH 本地插件、唯一工具命名、只读 SQLite 查询 | 已完成 |
| M1 | Application Overview 和可解释进度状态 | 已完成 |
| M2 | 无 Side Panel 的列表发现、指定岗位捕获和幂等保存 | 已通过测试账号端到端验收 |
| M2.5 | GankInterview `JobLead` 适配、来源 ID 去重、请求时快照/观察历史和人工 URL/JD 核验 | 已实现 |
| M2.6 | 批量岗位选择、有序本地队列、岗位级状态和 handoff checkpoint | 本地计划/状态/恢复已实现；外部执行未实现 |
| M2.7 | 腾讯 CSV/XLSX 与查看权限剪贴板快照导入、来源快照、当前事实和观察历史 | 核心链路和 DSH Web 加载已实现，待用户复制真实可见区域验收映射 |
| M2.8 | DSH 截图视觉结构化 preview、附件哈希校验、显式确认 apply 和低置信度隔离 | 核心工具与 fixture 已实现，待真实腾讯表当前视口验收 |
| M2.9 | 受控简历导入、不可变 ResumeVersion 目录和内容寻址本地工件 | 已实现；DSH Web PDF/DOCX 选择到 preview 已端到端验证，本地 v2 匹配和 9-case Gold/Badcase 基线已通过 |
| M3 | JD Watch 目标、节流、停止和变化 diff | 本地 Watch 核心、显式单次 poll、一次性到期批次 Scheduler 和结构化 diff 已实现；真实账号验收未完成 |
| M4 | 面经/招聘消息归档和学习博客联动 | 招聘消息只读捕获、面经 preview/apply 与时间线已整合；学习博客联动仍待整理 |
| M5 | Feishu 链接接入、字段映射、预览到审批再到幂等投影 | 本地/假客户端链路已实现；测试 Base 已验证单条写入，CLI 回执兼容与写后对账已补回归 |
| M6 | 官网表单预览、批量逐项 Gate B、串行辅助提交、Fresh Capture 与结果验证 | Gate A 和标准官网/ATS 表单只读脱敏预览已实现；真实 ATS 验收、填充、提交和结果验证未实现 |
| M7 | 按需 Launcher 与 DSH“求职中心” | 未实现 |

## 12. 事实边界

- **已实现**：本地采集 API、SQLite 追加式事件、Application Tracker read model、GankInterview `JobLead` 请求时快照与追加观察历史、腾讯 CSV/XLSX/剪贴板快照导入、DSH 截图视觉 preview/确认 apply、来源快照、绑定内容哈希的人工 URL/JD 核验及审计记录、受控 ResumeVersion 导入与内容寻址工件、DSH Web 简历选择按钮和本机短期上传会话、`local-evidence-match-v2` 与 Gold/Badcase runner、官网/ATS 标准表单只读脱敏预览、批次本地计划/状态/checkpoint、Browser Controller、BOSS 岗位详情/选中会话招聘方消息观察、面经 preview/apply、Watch 本地状态机/每日预算/显式单次 poll/一次性到期批次 Scheduler/停止与人工暂停、结构化 JD Diff、官网投递 Gate A 预览、Feishu 目标/映射与单向投影的本地/假客户端链路、DSH 插件、导出。
- **已验证**：fixture 中的无 Side Panel 捕获、幂等重试、服务身份、网页 Origin 拒绝、DSH Tool/Skill 组合和页面选择器；测试账号中的列表发现、指定岗位临时详情捕获、自动关页和幂等保存；DSH Web 中虚构 PDF 的选择、受控暂存、草稿生成和 `boss_watch_resume_import_preview` 调用；9 个虚构 Gold 场景和 6 个 Badcase 回归；GankInterview `/api/v1/campus` 的真实响应结构与只读 HTTP 适配 fixture；腾讯智能表两个公开只读岗位页的当前字段与链接形态；用户 Feishu 表的只读链接解析、字段读取、自动映射预览和单条记录回读；`lark-cli` 两种记录列表回执、无 `record_id` 写后唯一回查、Markdown URL 归一化及远端已有记录的 projection 恢复 fixture。
- **持续验收**：BOSS 页面结构兼容性、字段混淆降级和 Watch 风险预算；一次测试账号通过不代表长期稳定。
- **设计中**：常驻 Watch 后台调度、自动官方页面核验、模型增强的简历语义抽取、批量投递外部执行、风险感知节流、官网表单字段填充/上传/提交和外部 Action；Feishu 反向同步与多条真实记录的长期验收。当前 Gold 只是 9 个虚构固定场景，扩大模型边界前仍需增加经脱敏审查的真实分布样本。
- **不可宣称**：生产级日处理量、P99/P50 SLA、平台长期稳定性、自动投递成功率。

## 13. GitHub 开源边界

可以开源 DSH 插件、Controller 的通用接口、虚构 fixture、架构文档和本地启动脚本，但发布前必须做
独立的隐私与来源审查。仓库不得包含：

- API key、Cookie、服务凭据、二维码、手机号、真实简历、面试转录和个人投递记录；
- 本地 SQLite、`.env*`、浏览器 Profile、真实页面截图或调试导出；
- 从腾讯表、GankInterview、BOSS 或其他来源批量复制的数据集；
- 绕过登录、验证码、私有字体、平台频控或内部 API 的实现；
- 默认开启的外部发送、自动投递或飞书写入。

开源适配器只描述用户如何配置自己的来源，并记录来源条款、访问频率、数据最小化和删除方式。测试数据
全部使用虚构公司、岗位、链接和简历。创建 GitHub 仓库、推送代码或发布版本仍是独立外部动作，必须
由用户明确授权后执行。
