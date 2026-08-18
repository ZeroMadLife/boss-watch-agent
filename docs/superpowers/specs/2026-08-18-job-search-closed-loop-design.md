# 求职 Agent 端到端闭环设计

日期：2026-08-18

状态：设计已确认并进入分片交付；当前实现边界以 `docs/job-search-agent-spec.md` v0.20 为准

适用仓库：`boss-watch-agent`

运行底座：DeepSeek Harness（DSH）+ `boss-watch-dsh-plugin` + 本地 SQLite

## 1. 背景与目标

产品面向个人春招、秋招和实习求职。它把分散的简历、岗位信源、JD、BOSS 沟通、官网投递、
投递进度和面试复盘连接为一个可追溯闭环：

```text
简历版本
  -> 招聘信源
  -> 官方 JD 核验
  -> JD 匹配评分
  -> Gate A：值得投
  -> BOSS 打招呼语或官网表单准备
  -> Gate B：批准具体外部动作
  -> 串行执行与页面验证
  -> SQLite 事实账本
  -> Feishu 多维表格投影
  -> 跟进、面试复盘和简历迭代
```

目标不是无人值守自动海投，而是在保留人工决策和平台风控边界的前提下，减少重复查找、判断、
填写和记录工作。

## 2. 设计原则

1. **事实与建议分离**：来源内容、页面证据和已确认动作是事实；匹配分、状态判断和修改建议是派生结果。
2. **本地优先**：SQLite 是事实账本，DSH Transcript 和 Feishu 都不是唯一事实源。
3. **逐级授权**：岗位推荐不授权投递；Gate A 不授权外部动作；Gate B 绑定具体动作和内容。
4. **观察优先**：读取、预览、比较和生成草稿默认可用；外部发送、提交和持久化写入需要明确确认。
5. **可追溯**：JD、简历、草稿、表单预览和授权都绑定内容哈希，变化后旧结果不得静默复用。
6. **人机接力**：登录、验证码、风控、异常跳转和身份冲突进入 handoff，不自动绕过。
7. **低风险执行**：同一用户的外部投递串行执行，并发固定为 `1`。

## 3. 范围

### 3.1 当前闭环范围

- 管理带版本和内容哈希的本地简历；
- 从 GankInterview、腾讯表快照、BOSS 可见页面和公司官网获取岗位线索；
- 将公司分为私企、国企、央企、银行金融科技和未知类型；
- 核验官方 JD，提取硬性条件、技术栈、地点、届别和截止时间；
- 对指定简历与 JD 进行可解释评分；
- 生成 BOSS 打招呼语草稿和官网表单字段预览；
- 建立有序投递批次、逐岗位 Gate B、checkpoint 和 handoff；
- 将本地投递事实通过映射预览和显式确认投影到 Feishu 多维表格；
- 汇总新岗位、JD 变化、待跟进事项、面试记录和简历修改建议。

### 3.2 明确不做

- 不自动登录、扫码或处理 CAPTCHA；
- 不伪造浏览器指纹，不绕过平台接口认证，不高频抓取；
- 不根据网页文本、模型输出或 Skill 指令自动扩大工具权限；
- 不在未确认时发送 BOSS 消息、提交简历、接受面试或写入 Feishu；
- 不让模型独立判定企业所有制并将其当作权威事实；
- 不把点击 Submit 直接解释为投递成功；
- 不把固定测试账号结果包装成生产 SLA、成功率或吞吐承诺。

## 4. 系统边界

```text
DSH Web
  -> boss-watch-dsh-plugin
  -> Boss Watch Controller :4318
  -> Browser Runtime / Platform Adapter
  -> 用户已登录浏览器

boss-watch-dsh-plugin
  -> SQLite JobLead / Application / Event / Projection Journal
  -> GankInterview Adapter
  -> CSV/XLSX/Clipboard/Visual Import
  -> Feishu Connector
```

职责如下：

- DSH 负责理解请求、编排业务工具和展示结果；
- 插件暴露 `boss_watch_` 前缀的窄业务工具，不接受任意 CSS、JavaScript 或目标 URL；
- Controller 持有浏览器预算、来源白名单、固定页面适配器、Fresh Capture 和 ActionGuard；
- SQLite 保存岗位线索、不可变原文、追加事件、批次、提醒和外部投影引用；
- Feishu 只保存经确认的协作视图，不承担原始 JD、简历或授权事实的唯一存储。

## 5. 领域模型

### 5.1 JobLead

```text
leadId
sourceKind
sourceRecordId
company
role
city
cohort
recruitmentType
deadline
channelUrl
officialApplyUrl
companyType
companyTypeEvidence
confidence
contentHash
fetchedAt
```

`confidence` 按 `source_only -> url_verified -> jd_verified -> human_confirmed` 单向提升。来源内容变化时，
依赖旧内容的核验结果必须失效。

### 5.2 ResumeVersion

```text
resumeVersionId
displayName
localArtifactRef
contentHash
createdAt
supersedesResumeVersionId?
```

简历内容不进入日志或 DSH Transcript。后续匹配、草稿和表单预览都引用具体 `resumeVersionId` 和
`contentHash`。

当前已实现受控本地导入：预览时计算 SHA-256，确认时复核并复制为内容寻址工件，SQLite 只保存上述版本
元数据。支持 PDF、DOCX、Markdown 和 TXT。第一版本地正文提取与 JD 匹配已实现：只对已捕获完整 JD 的
application 运行固定词表和硬约束规则，输出哈希、技能命中/缺口、未知项和可解释分数；不返回简历正文，
也不把规则分数包装成模型语义理解或生产筛选结论。

### 5.3 MatchResult

```text
matchId
leadId
jdContentHash
resumeVersionId
resumeContentHash
hardConstraintResult
matchLevel
evidence[]
gaps[]
risks[]
createdAt
```

匹配结果必须提供来源证据和缺口；JD 或简历哈希变化后，旧结果只保留审计价值，不再支持新投递。

### 5.4 Application

```text
applicationId
leadId
company
role
channel
confirmedStatus
createdAt
latestObservedAt
```

状态通过追加事件派生，不直接覆盖历史。`status_proposed` 不是确认状态。

### 5.5 FeishuTarget 与 Projection

```text
FeishuTarget
  targetId
  baseToken
  tableId
  viewId?
  identity
  schemaHash
  fieldMapping
  connectedAt

ExternalProjection
  targetId
  localEntityKind
  localEntityId
  remoteRecordId
  lastProjectedHash
  lastProjectedAt
  lastResult
```

用户授权凭据不保存在该模型中。资源 ID 和字段映射是本地配置，认证由用户自己的 Feishu 身份提供。

### 5.6 Watch、FollowUp 与 Interview

```text
WatchSubscription
  watchId, sourceKind, targetRef, interval, budget, state, lastObservedAt

FollowUp
  followUpId, applicationId, dueAt, reason, note, state

InterviewRecord
  interviewId, applicationId, round, scheduledAt, sourceArtifactRef, state
```

面试原始记录与修正后的复盘分开保存，避免修改后的总结覆盖原始证据。

## 6. 端到端流程

### 6.1 信源进入候选池

新用户或新会话先调用只读 `boss_watch_workspace_overview`，根据本地简历、候选、核验和完整 JD 状态选择
一条来源路径。overview 不刷新任何来源；GankInterview、BOSS 当前页、文件、剪贴板和截图均由用户明确选择后
单独触发。

```text
来源读取
  -> 归一化 JobLead
  -> 保存当前快照和 observation
  -> 去重
  -> 标记 source_only
  -> 进入求职收件箱
```

GankInterview 使用稳定来源 ID。腾讯表文件、剪贴板和截图使用受控快照；视觉截图必须先 preview，
再显式 apply。截断 URL 不作为去重锚点，也不写入 `channelUrl`。

### 6.2 企业分类

规范字段：

```text
companyType = private | state_owned | central_state_owned | bank_fintech | unknown
```

分类同时保存 `companyTypeEvidence`。可接受的证据包括官方企业说明、已核验招聘官网信息和用户确认。
仅凭公司名称或模型常识时只能保持 `unknown` 或返回待确认建议。

### 6.3 官方 JD 核验

来源链接只能作为候选。系统打开用户选定且符合安全约束的官网或 ATS 页面，核对公司、岗位和当前 JD，
保存可见原文及内容哈希。核验失败时不得进入投递批次。

### 6.4 简历匹配与 Gate A

```text
已核验 JD + 指定简历版本
  -> 硬性条件检查
  -> 技术栈和经历证据匹配
  -> 输出匹配等级、证据、缺口和风险
  -> 用户确认 Gate A
```

Gate A 只表示值得准备或值得投，不批准发送消息、填写表单或提交。

### 6.5 投递准备与 Gate B

#### BOSS

- 根据当前 JD、用户经历证据和当前会话生成打招呼语草稿；
- 用户可以编辑草稿；
- 草稿保存内容哈希；
- 默认只展示，不发送；
- 未来发送授权必须绑定 session、conversation、recipient、exact content hash 和 expiresAt。

#### 官网与 ATS

- 只打开已核验的 `officialApplyUrl`；
- 先读取表单字段并生成“简历字段 -> 页面字段”预览；
- 缺失或冲突字段要求用户补充；
- 获得填充授权后可辅助填写，但停在最终 Submit 前；
- 最终动作前再次 Fresh Capture；页面身份、字段或内容变化使旧授权失效。

#### 批次

- 用户选择并排序已核验岗位；
- `prepare` 只创建本地计划；
- 用户可以在一次批次预览中勾选多项，但每一项签发独立 Gate B；
- 串行执行，每项完成验证后才进入下一项；
- 登录、验证码、风控、页面变化和不确定结果进入 `handoff_required`；
- `resume` 清除旧授权并回到 `awaiting_gate_b`，不自动重放动作。

### 6.6 事实写入与 Feishu 投影

外部页面出现明确成功证据后，先向 SQLite 追加 `submitted_observed` 或对应状态事件，再生成 Feishu
投影预览。Feishu 失败不回滚本地事实，也不把本地状态改为失败。

### 6.7 后续反馈

- 招聘方消息形成原始工件和状态建议；
- 用户确认后追加状态事件；
- 提醒进入本地 follow-up inbox；
- 面试安排、轮次、结果和复盘进入 Application 时间线；
- 复盘产生简历或表达修改建议；
- 用户确认后创建新 `ResumeVersion`，旧匹配结果仍保留。

## 7. Feishu 新用户接入

### 7.1 输入契约

用户只需提供一个自己有权访问的 Feishu Base 或 Wiki 内嵌 Base 链接。链接负责定位资源，不代表写入授权。

```text
链接
  -> resolve baseToken/tableId/viewId
  -> 读取 Base、表、视图和字段
  -> 自动映射
  -> 映射预览
  -> 用户确认
  -> 保存 FeishuTarget
```

无法读取时返回身份或资源权限错误；不得通过切换身份反复尝试。只有只读权限时允许完成结构预览，
写入阶段必须明确提示权限不足。

### 7.2 半自动字段映射

第一版按字段名、类型和单选选项自动匹配，允许用户在确认前修正。最小必需语义字段是：

- 公司；
- 岗位；
- 至少一个稳定身份来源：岗位链接、远端业务键，或本地 projection 映射。

已验证的目标表示例映射：

| 本地语义 | 目标字段 | 规则 |
| --- | --- | --- |
| `company` | 公司名称 | 必填文本 |
| `role` | 岗位名称 | 必填文本 |
| `officialApplyUrl/jobUrl` | 岗位链接 | URL 文本，可为空 |
| `sourceKind` | 投递平台 | 只写已存在选项 |
| `confirmedStatus` | 当前进度 | 只写已存在选项 |
| `appliedAt` | 投递时间 | 仅确认投递后写 |
| `deadline` | 截止时间 | 绝对日期时间 |
| `city` | 城市 | 文本 |
| `location` | 地点 | 文本 |
| `summary` | 备注 | 可追溯摘要，不写完整敏感原文 |
| `priority` | 推荐优先级 | 可选 |
| `matchLevel` | JD匹配度 | 可选 |
| `companyType` | 公司类型 | 只写可映射选项 |

`created_at`、`updated_at`、公式和 lookup 等系统/只读字段不得写入。

### 7.3 同步协议

设计工具：

| 工具 | 作用 | 外部影响 |
| --- | --- | --- |
| `boss_watch_feishu_target_preview` | 解析链接、读取结构、生成映射预览 | 只读 |
| `boss_watch_feishu_target_confirm` | 保存本地目标与映射 | 仅本地写入 |
| `boss_watch_feishu_sync_preview` | 计算 create/update/unchanged/conflict | 只读 |
| `boss_watch_feishu_sync_apply` | 消费短期 token 并串行写入 | Feishu 写入，需明确确认 |

已有 `boss_watch_feishu_preview` 保留兼容，后续由新 preview 能力替代其固定字段输出。

`sync_preview` 返回：

```text
target summary
schemaHash
source facts hash
create[]
update[] with field diffs
unchanged[]
conflict[]
warnings[]
previewToken
expiresAt
```

`previewToken` 绑定用户会话、目标、schemaHash、源事实哈希、字段映射、精确变更集和过期时间。
任何一项变化都要求重新预览。

### 7.4 幂等规则

查找顺序：

1. 本地 `ExternalProjection` 中保存的 `remoteRecordId`；
2. 目标表中的稳定业务键；
3. 规范化后的岗位链接；
4. 公司 + 岗位 + 城市的复合候选。

第 4 层出现多个候选时返回 `conflict`，不得自动选中。Feishu 的 record upsert 本身不会按业务键查重，
所以系统必须先读记录并保存远端 `record_id`，不能把无 `record_id` 的重复请求当作更新。当前 `lark-cli`
创建回执可能不包含 `record_id`；此时只允许在同一次已批准写入后分页只读回查，按规范化岗位链接优先、
公司+岗位回退做唯一对账。裸 URL 与 Feishu 返回的 Markdown 链接视为同一身份值；零条或多条候选都必须
失败关闭，不能为了取得 ID 再发一次 upsert。

### 7.5 第一版同步方向

第一版只支持“SQLite -> Feishu”单向投影。Feishu 中的人工编辑不会后台覆盖 SQLite。后续反向同步采用：

```text
按需读取 Feishu 变化
  -> 生成状态变化预览
  -> 用户确认
  -> 追加本地事件
```

不做无提示的双向合并。

## 8. 状态与错误处理

### 8.1 投递项状态

```text
queued
  -> awaiting_gate_b
  -> running
  -> completed | failed | handoff_required | skipped

handoff_required
  -> 用户处理并 resume
  -> awaiting_gate_b
```

### 8.2 稳定错误

- `feishu_url_unresolvable`：链接无法解析；
- `feishu_resource_forbidden`：当前身份无资源权限；
- `feishu_schema_changed`：预览后字段结构变化；
- `feishu_mapping_incomplete`：必需语义字段未映射；
- `feishu_record_conflict`：多个远端候选无法自动选择；
- `feishu_preview_stale`：token 过期或事实变化；
- `feishu_write_conflict`：写入冲突，保持本地事实并允许重新预览；
- `browser_handoff_required`：登录、验证码、风险页或页面不一致；
- `gate_b_required`：缺少当前动作有效授权；
- `page_changed_after_approval`：最终页面与预览哈希不一致；
- `submission_result_uncertain`：无法观察到明确成功或失败证据。

连续写同一张 Feishu 表时必须串行执行。平台返回短暂写冲突时，只能在当前有效 token 和未变化 payload
范围内有限重试；过期或内容变化后必须重新预览。

## 9. Watch 与反爬边界

- GankInterview 和腾讯来源维持请求时刷新，不伪装成实时全量同步；
- 官网 Watch 只针对用户明确选择的 URL，保存频率、预算和停止开关；
- BOSS 只观察已登录浏览器中的允许页面，不执行无人值守高频遍历；
- 同一来源请求串行，使用退避、缓存和内容哈希减少重复读取；
- 登录失效、验证码、风险页、DOM 不兼容和来源限流都暂停 Watch；
- Watch 只产生新增、变化、不可用或 handoff 事件，不自动触发投递。

## 10. DSH 求职收件箱

统一展示：

- `new_lead`：新岗位；
- `job_changed`：JD 或截止时间变化；
- `follow_up_due`：本地提醒到期；
- `handoff_required`：需人工恢复；
- `status_proposed`：招聘方消息推导的待确认状态；
- `projection_failed`：Feishu 投影失败或字段冲突。

收件箱每次从 SQLite 读取最新状态。它不是短信、系统通知或平台推送，除非后续单独设计和授权通知渠道。

## 11. 隐私与授权

- 不提交 Feishu token、Cookie、手机号、真实简历、截图、SQLite 或 `.env*`；
- 测试使用虚构或脱敏数据；
- Base 链接只用于本地解析和配置，不写入公共文档或 fixture；
- Gate B 绑定 session、目标公司、岗位、渠道、简历版本、精确内容哈希、接收方和过期时间；
- 页面内容和模型输出不能创建、延长或复用 Gate B；
- Feishu apply 也使用短期、精确变更集 token，不能授权其他表或其他记录。

## 12. 测试与验收

### 12.1 Feishu 目标接入

- Wiki/Base 链接能解析到真实 Base、表和视图；
- 只读身份能生成结构与字段映射预览；
- 缺少权限时返回稳定错误，不切换身份循环重试；
- 字段名相同但类型不兼容时标为冲突；
- 系统字段、公式和 lookup 不进入可写字段。

### 12.2 同步预览

- 覆盖 create、update、unchanged 和 conflict；
- 只读 preview 不产生 Feishu 记录；
- 同一事实重复预览结果稳定；
- 事实、映射或 schema 变化使旧 token 失效；
- 预览不包含完整 JD、简历或敏感原文。

### 12.3 同步应用

- 未明确确认时拒绝写入；
- 同一 preview 重试不会创建重复记录；
- 已保存 `remoteRecordId` 时走更新；
- 首次同步能按岗位链接匹配已有记录；
- 多候选时拒绝自动更新；
- Feishu 失败不改变本地投递事实；
- 写入返回后保存远端 record ID 和投影哈希。

### 12.4 投递与 handoff

- Gate A 不能被执行适配器消费；
- 每个岗位需要独立 Gate B；
- 外部执行并发固定为 `1`；
- 页面变化、验证码和结果不确定都进入 handoff；
- resume 清除旧授权；
- 只有明确成功证据产生 `submitted_observed`。

### 12.5 端到端验收场景

使用脱敏数据完成：

1. 导入一个岗位线索；
2. 核验官方链接和 JD；
3. 绑定一个虚构简历版本并生成匹配结果；
4. Gate A 后创建单岗位批次；
5. 生成 BOSS 草稿或官网字段预览，但不发送/提交；
6. 模拟成功观察事件；
7. 生成 Feishu 同步预览；
8. 显式确认后创建或更新一条测试记录；
9. 重复同步得到 unchanged；
10. 清理测试记录或使用专用测试 Base，避免影响真实投递表。

## 13. 交付顺序

### 已实现并验证

- 本地 SQLite 事件和 Application read model；
- 从零开始的 workspace overview、精确计数和单来源路由；
- BOSS 可见列表发现与指定详情捕获；
- GankInterview 请求时快照和观察历史；
- CSV/XLSX、剪贴板和截图视觉岗位导入；
- 视觉 preview/apply、附件哈希、低置信度隔离和截断 URL 防误去重；
- 人工 URL/JD 核验；
- 受控 ResumeVersion 导入、内容寻址本地工件和版本元数据查询；
- DSH Web PDF/DOCX 选择、受控暂存和 preview 草稿；
- `local-evidence-match-v2`、9-case 虚构 Gold/Badcase runner 和 PDF/DOCX 提取降级回归；
- 官网/ATS 标准表单的同源只读检查、现有值脱敏、简历字段可用性分类和 handoff fixture；
- 本地跟进提醒；
- 批次 prepare/status/resume 和 checkpoint；
- 只读 `boss_watch_feishu_preview`。

### 当前纵向切片：官网/ATS 表单读取与脱敏预览

1. 已实现只读取用户明确打开、与已核验 `officialApplyUrl` 同源的唯一官网/ATS 页面；
2. 已将字段分为简历可提供、需用户补充、敏感和未知四类，页面现有值只返回是否存在；
3. 已生成绑定 lead/resume/form hash 的字段预览，不写 DOM、不上传、不提交；
4. 登录、验证码、风险页、不同源、多标签页和未知表单进入 handoff；
5. 虚构标准表单 fixture 已通过；真实 ATS 页面适配仍需用户明确打开页面后逐站验收，验收通过前不设计 Gate B 填充动作。

### 下一纵向切片：真实 ATS 只读验收与人工修正

1. 在用户测试账号上选择一个已核验官网/ATS 岗位并人工打开申请页；
2. 核对标准控件、SPA 自定义控件、分页表单和登录/验证码 handoff；
3. 对语义误判增加本地、可审计的字段映射修正，不把模型猜测直接升级为事实；
4. 只有只读预览稳定后，才单独制定字段填充 Gate B、Fresh Capture 和最终 Submit 前停止规则。

### 后续独立切片

1. BOSS 打招呼语与可审计草稿；
2. 外部动作 Gate B 和串行执行适配器；
3. Feishu 到 SQLite 的按需、确认式反向同步；
4. 面试复盘和简历版本迭代；
5. 求职中心与按需 Launcher。

## 14. 当前决策

- 新用户通过一个 Feishu Base/Wiki 链接接入；
- 第一版采用半自动字段映射；
- 第一版只做 SQLite 到 Feishu 的单向投影；
- 当前真实投递表不新增字段，幂等映射先保存在本地 SQLite；
- Feishu 写入采用 preview -> explicit apply；
- 批量投递按岗位串行，每项独立 Gate B；
- 公司分类保存证据与置信边界；
- 具体 JD 评分、草稿模板和官网表单适配器在后续切片单独制定。
- Hosted Job Source API 是个人闭环稳定后的独立产品化层；只提供公共 `JobLead`，不持有用户私有事实；计费单位和价格暂未决定。
