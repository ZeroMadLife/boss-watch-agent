# Job Source Import and Snapshot Design

日期：2026-08-17
状态：CSV/XLSX 核心链路已实现；查看权限场景增加剪贴板快照入口
里程碑：M2.7
范围：CSV/XLSX 与剪贴板岗位来源导入、多来源当前事实与观察历史

## 1. 背景

现有系统已经实现 GankInterview 校招岗位的请求时搜索、`job_leads` 当前快照、
`job_lead_observations` 追加观察、人工 URL/JD 两步核验，以及内容变化后的核验失效。
已验收行为包括 `new / unchanged / changed` 分类、精确重试幂等和 A -> B -> A 历史保留。

腾讯智能表目前只是经过人工核对的外部来源。它的表格主体依赖 Canvas，
缺少可依赖的稳定行 DOM ID。M2.7 不逆向其私有接口，也不做无人值守页面轮询，而是读取用户
通过官方能力导出的 CSV/XLSX 文件；若用户只有查看权限，则读取用户在可见表格区域中主动复制的本机剪贴板快照。

本设计中的“同步”只表示用户按需把一个来源文件导入本地。它是单向的：

```text
腾讯文档官方导出文件 -> 本地预览 -> 用户确认 -> SQLite
腾讯文档可见表格区域 --用户复制--> 本机剪贴板 -> 本地预览 -> 用户确认 -> SQLite
```

系统不写回腾讯文档。`job_leads` 保存每条岗位的最新本地事实，来源快照和观察表保留每次成功
导入的审计历史。

## 2. 目标

1. 让 CSV/XLSX 中的岗位和 GankInterview 岗位进入同一个 `JobLead` 候选池。
2. 维护可查询的最新本地事实，同时保留来源文件和逐岗位变化历史。
3. 在实际写入前展示字段映射、接受行、拒绝行、重复行和预计变化。
4. 保证同一文件重试幂等，内容变化可追溯，旧人工核验不能错误复用。
5. 让 DSH 能回答“当前最新岗位是什么、从哪里来的、何时导入、哪些发生了变化”。

## 3. 非目标

- 不逆向腾讯文档 Canvas 或内部 API；
- 不在后台定时下载、轮询或抓取腾讯文档；
- 不读取腾讯文档私有接口或 Canvas 内部结构；剪贴板入口只读取用户主动复制的本机快照；
- 不根据“本次文件中未出现”自动判定岗位关闭、删除或停止招聘；
- 不自动访问来源链接、公司官网或 ATS；
- 不自动核验官网 JD，不执行投递、填表、发送消息或写入飞书；
- 不把完整来源文件、真实简历或岗位原文发送给模型或第三方服务；
- 不把个人 SQLite 描述成大型招聘平台的共享队列或生产级同步系统。

## 4. 用户流程

```text
用户从腾讯文档导出 CSV/XLSX，或选中可见表格区域并复制
  -> 文件放入受控本地导入目录，或 DSH 读取本机剪贴板
  -> DSH 调用 boss_watch_lead_import_preview / boss_watch_lead_clipboard_preview
  -> 本地解析器识别工作表、表头和字段映射
  -> 返回有效/拒绝/重复行及 new/changed/unchanged 预估
  -> 用户明确确认本次导入
  -> DSH 调用 boss_watch_lead_import_apply
  -> 重新读取并核对 fileHash、mappingHash、剪贴板哈希和预览有效期
  -> 在一个 SQLite 事务中写来源快照、当前事实和观察历史
  -> 返回导入摘要和可定位的错误报告
```

预览不授权其他外部动作。导入成功也只表示“本地已经记录该来源的最新观察”，不表示链接已经核验、
岗位仍开放或已经投递。

## 5. 模块边界

### 5.1 `TabularSourceReader`

职责：使用固定、直接依赖并锁定版本的结构化解析库读取 CSV/XLSX，不包含业务去重和数据库逻辑。

输入：受控目录内已经解析为真实路径的文件。
输出：工作表列表、表头、行号和单元格原值。
约束：不执行公式、宏、外部链接或嵌入对象；只读取用户选择的工作表和配置的最大行数。

### 5.2 `TencentLeadMapper`

职责：把腾讯表的中文列映射为统一 `JobLead` 输入，生成逐行校验结果。

它只根据显式表头别名和用户确认的映射工作，不让模型逐行自由解释。未知列保留在本地导入报告中，
但默认不进入 `JobLead`，也不发送给模型。

### 5.3 `LeadImportPreviewService`

职责：计算文件哈希、映射哈希、行分类预估和短期预览令牌，不写业务事实。

预览令牌绑定当前进程、文件哈希、字段映射、工作表、来源引用和过期时间。令牌默认 15 分钟有效；
服务重启、文件变化、映射变化或过期后必须重新预览。

### 5.4 `JobLeadStore`

职责：在一个事务中写入来源快照、`job_leads` 当前事实和 `job_lead_observations` 历史。

现有 GankInterview 与人工核验语义继续复用。导入模块不能绕过内容哈希变化后的核验失效规则。

### 5.5 `ClipboardImportAdapter`

职责：使用 macOS `pbpaste` 读取用户主动复制的可见表格区域，将制表符文本或逗号文本适配为统一表格输入。

它不访问腾讯网络、不轮询剪贴板、不把完整剪贴板原文写入 DSH transcript；预览最多返回字段映射、统计和五行
脱敏摘要。预览令牌绑定剪贴板 SHA-256，应用前剪贴板发生任何变化都返回 `clipboard_changed_since_preview`，
要求用户重新复制并预览。`pbpaste` 不可用时返回 `clipboard_unavailable`。

## 6. 统一字段

```text
sourceKind          gankinterview_campus | tencent_smart_sheet | boss_visible | company_career_site
sourceRecordId      来源稳定 ID；腾讯导入无稳定 ID 时为 provisional ID
company             公司原文，必填
role                岗位或招聘方向原文，必填
city                工作地点原文，可空
cohort              届别或招聘对象原文，可空
recruitmentType     校招、实习、提前批等原文，可空
deadline            截止时间或“招满为止”等原文，可空
channelUrl          来源给出的公告或投递线索，可空
officialApplyUrl    已核验官网/ATS URL；导入时始终为空
sourceUpdatedAt     来源表中的更新时间，可空
fetchedAt           本次成功导入时间
rawRef              本地来源引用，不复制完整外部表
contentHash         规范化事实字段的 SHA-256
confidence          导入时只能是 source_only
```

### 6.1 默认中文表头别名

| 标准字段 | 接受的表头别名 |
| --- | --- |
| `company` | 公司、企业、单位、公司名称、企业名称 |
| `role` | 岗位、职位、招聘岗位、招聘职位、岗位方向 |
| `city` | 地点、工作地点、城市、办公地点 |
| `cohort` | 届别、面向人群、招聘对象 |
| `recruitmentType` | 招聘类型、招聘批次、类型 |
| `deadline` | 截止时间、报名截止、投递截止 |
| `channelUrl` | 投递链接、公告链接、来源链接、网申地址 |
| `sourceUpdatedAt` | 更新时间、发布日期、更新日期 |

自动映射只能在一个标准字段命中一个来源列时成立。一个标准字段命中多个列、一个来源列命中多个字段，
或者 `company`/`role` 未命中时，预览返回 `mapping_required`，由用户确认后才能继续。

### 6.2 规范化边界

- 去除字段首尾空白，统一连续空白，但保留中文原文和语义标点；
- URL 只接受 `https`，禁止用户信息、非 443 显式端口、localhost、局域网域名和 IP；
- 导入链接只写入 `channelUrl`，不能因域名看似正确就写入 `officialApplyUrl`；
- Excel 日期转换为 ISO 日期前必须保留原始单元格显示值用于本地错误定位；
- 公式单元格不求值；没有可信缓存值时该字段按空值处理并产生警告；
- `contentHash` 只覆盖会影响岗位身份或核验的规范化事实字段，不包含 `fetchedAt`、文件名和行号。

## 7. 来源 ID 与去重

腾讯文件没有稳定行 ID 时生成 provisional ID。优先使用来源中相对稳定的链接作为行锚点：

```text
provisionalSourceRecordId =
  sha256(sourceDocumentRef + sheetName + identityAnchor)

identityAnchor =
  normalizedChannelUrl
  OR company + cohort + recruitmentType + role
```

只有存在合法 `channelUrl` 时才使用链接锚点；否则退化为字段组合。它用于同一腾讯来源内的当前事实定位，
不承诺跨表结构变更永久稳定。来源引用由用户配置的文档 URL、sheet/view 标识或本地来源名称组成，
不能只使用文件名。

没有稳定链接时，岗位名称或公司名称的修改可能形成新的 provisional ID。系统不能在证据不足时把新旧两行
强行认定为同一岗位，因此只返回 `possibleDuplicate`，也不会把旧行标记为关闭。`changed` 只在来源 ID
保持一致且内容哈希变化时成立。

去重按以下顺序执行：

1. `sourceKind + sourceRecordId`；
2. 已经人工核验的规范化 `officialApplyUrl`；
3. 同一来源内 `company + role + cohort + city + contentHash`；
4. 跨来源只生成 `possibleDuplicate` 提示，不自动合并。

公司相同但岗位、城市、届别或链接不同的记录不能自动合并。跨来源合并需要以后单独设计稳定的
canonical job，不属于 M2.7。

## 8. 持久化模型

### 8.1 当前事实

现有 `job_leads` 继续作为最新本地事实表。每个 `sourceKind + sourceRecordId` 只有一个当前版本。
成功导入后，DSH 的候选列表立即读取这个表。

### 8.2 来源快照

新增 `job_source_snapshots`：

```text
snapshotId
sourceKind
sourceRef
fileHash
mappingHash
sheetName
importedAt
rowCount
acceptedCount
rejectedCount
duplicateCount
newCount
changedCount
unchangedCount
status              applied
```

只有成功提交的导入写入快照。解析失败、预览和事务回滚不生成 `applied` 快照。同一个 preview token
重复 apply，或者文件哈希与该来源最近一次成功快照相同且期间没有新快照时，返回最近的 `snapshotId`，
不重复写观察记录。若先导入 A、再导入 B、之后重新导入 A，最后一次 A 必须生成新快照，以保留
A -> B -> A 的变化历史。

### 8.3 观察历史

现有 `job_lead_observations` 继续保存：

```text
leadId
sourceKind
sourceRecordId
contentHash
previousContentHash
previousConfidence
changeKind          new | unchanged | changed
verificationInvalidated
observedAt
snapshotId          新增可空关联；旧 Gank 观察保持可读
```

`rejected` 和导入文件内部的 `duplicate` 不是岗位事实，不写入 `job_lead_observations`。它们写入
快照统计和本地导入报告，避免用无效行污染岗位时间线。

### 8.4 导入报告

导入报告只保存在本地应用数据目录，包含工作表、行号、稳定错误码和脱敏字段摘要，不复制整行敏感内容。
数据库保存报告引用和摘要，不保存原始 CSV/XLSX 二进制文件。用户删除源文件不影响已经写入的事实，
但之后无法从报告还原完整原行。

## 9. 变化与核验规则

逐岗位分类沿用现有行为：

- 首次出现：`new`；
- 当前内容哈希相同：`unchanged`；
- 当前内容哈希不同：`changed`；
- A -> B -> A：保留三次观察，A 的回归不是删除 B；
- 当前文件未包含旧岗位：不生成删除、关闭或 changed 观察。

内容变化时必须在同一事务中：

1. 更新 `job_leads` 当前事实；
2. 清空旧 `officialApplyUrl`；
3. 把 confidence 退回 `source_only`；
4. 追加 `verificationInvalidated = true` 的观察；
5. 保留 `job_lead_verifications` 历史审计；
6. 阻止旧 `leadContentHash` 进入批次 Gate B 或恢复执行。

同内容重复导入保留当前最高置信度，不重新核验，也不产生新的人工确认记录。

## 10. DSH 工具契约

### 10.1 `boss_watch_lead_import_preview`

输入：

```text
sourceRef           用户确认的腾讯文档来源引用
fileName            受控导入目录中的文件名，不接受任意路径
sheetName           XLSX 可选；多工作表且未指定时返回 sheet_selection_required
columnMapping       可选的显式标准字段到来源列映射
```

输出：

```text
status
previewToken
expiresAt
fileHash
mappingHash
sheetName
headers
resolvedMapping
rowCount
acceptedCount
rejectedCount
duplicateCount
estimatedNewCount
estimatedChangedCount
estimatedUnchangedCount
warnings
sampleRows          最多 5 行脱敏摘要
```

该工具不写业务数据库、不访问腾讯网络、不上传文件。无效路径、符号链接逃逸、超限文件和不支持格式
在解析前拒绝。

### 10.2 `boss_watch_lead_import_apply`

输入：

```text
previewToken
confirmation        用户对本次来源、工作表和统计摘要的明确确认
```

执行前重新读取文件并校验哈希、映射、来源、工作表和过期时间。任一不一致都返回
`preview_stale`，不做部分写入。

输出：

```text
status
snapshotId
sourceRef
importedAt
acceptedCount
rejectedCount
duplicateCount
newCount
changedCount
unchangedCount
verificationInvalidatedCount
reportRef
```

### 10.3 `boss_watch_lead_clipboard_preview`

输入：

```text
sourceRef           用户确认的腾讯文档来源引用或 view 标识
columnMapping       可选的显式标准字段到来源列映射
```

工具从本机剪贴板读取用户主动复制的可见区域，默认识别 TSV，兼容逗号分隔文本。返回与文件预览相同的字段
映射、行统计、变化预估和最多五行脱敏样例，不返回完整单元格内容，不写 SQLite。空剪贴板返回
`clipboard_empty`。

### 10.4 `boss_watch_lead_clipboard_apply`

输入：

```text
previewToken
confirmation        用户对本次来源和统计摘要的明确确认
```

只有确认字符串非空且剪贴板哈希仍与预览一致时才复用 `LeadImportPreviewService` 的事务写入。剪贴板变化、
令牌过期或服务重启均要求重新预览；成功后仍只表示本地保存了一个人工复制快照，不表示腾讯表已实时同步。

### 10.5 `boss_watch_source_status`

只读本地，按来源返回最近成功快照、导入时间、文件哈希短摘要、数量统计和最近错误摘要。它不刷新
GankInterview，也不读取腾讯文档。

现有 `boss_watch_lead_observation_list` 继续只返回有效岗位的 `new/changed/unchanged` 观察。

## 11. 事务、并发与幂等

- 同一个 `sourceKind + sourceRef` 同时只允许一个 apply；冲突返回 `import_in_progress`；
- preview 可以并发，但 token 只绑定各自文件和映射；
- apply 使用 `BEGIN IMMEDIATE`，快照、当前事实和观察要么全部成功，要么全部回滚；
- 同一个 preview token 重复 apply 返回原 `snapshotId`；
- 与来源最近成功快照完全相同的文件和映射返回最近 `snapshotId`；A -> B -> A 中最后的 A 不是重复；
- 不为本地个人工具引入 Redis、Worker 池或多进程导入队列；
- 第一版设置明确上限：单文件 20 MiB、单工作表 20,000 行、单元格文本 32 KiB；超限返回稳定错误码；
- SQLite 写入保持串行，解析和预览不持有数据库写锁。

## 12. 错误处理

| 错误码 | 行为 |
| --- | --- |
| `unsupported_file_type` | 只接受 `.csv`、`.tsv` 和 `.xlsx`；TSV 主要由剪贴板适配层生成 |
| `file_outside_import_root` | 拒绝任意路径和符号链接逃逸 |
| `file_too_large` | 解析前拒绝 |
| `sheet_selection_required` | 返回工作表名称，不猜测目标 |
| `mapping_required` | 返回冲突或缺失映射 |
| `invalid_required_field` | 该行进入拒绝报告，其他有效行可继续预览 |
| `invalid_channel_url` | URL 字段置空并产生行警告；公司和岗位有效时仍可导入 |
| `duplicate_row` | 只接受文件内第一次出现的完全相同行，后续行进入重复统计 |
| `preview_stale` | 文件、映射、来源、工作表、进程或有效期变化，要求重新预览 |
| `clipboard_changed_since_preview` | 剪贴板哈希变化，要求重新复制并预览 |
| `clipboard_empty` | 剪贴板没有可解析文本 |
| `clipboard_unavailable` | 当前系统没有可用的 `pbpaste` |
| `import_in_progress` | 不并发写同一来源 |
| `database_unavailable` | 不返回伪造空结果，不生成成功快照 |
| `import_failed` | 事务回滚，保留不含敏感正文的错误摘要 |

## 13. 安全和隐私

- DSH 只能引用受控导入根目录下的文件名，不能传绝对路径、`..` 或任意 URL；
- 解析器不执行宏、公式、外部数据连接或嵌入脚本；
- 文件内容只在本机解析，不进入 DSH Transcript；工具仅返回字段名、统计和少量脱敏样例；
- 测试只使用虚构公司、岗位、URL 和文件内容；
- 不提交真实导出文件、Cookie、Token、手机号、简历、聊天记录或 `.env*`；
- 页面文本、表格单元格和模型输出都不能授予官网访问、投递或消息发送权限；
- 登录、验证码和平台风控继续由用户处理。

## 14. 可观测性

每次成功导入记录本地结构化摘要：

```text
snapshotId
sourceKind
durationMs
rowCount
acceptedCount
rejectedCount
duplicateCount
newCount
changedCount
unchangedCount
verificationInvalidatedCount
```

日志不记录单元格正文、完整 URL 查询参数或源文件内容。本阶段报告导入结果和本地耗时，不宣称
实时同步率、生产吞吐或线上 P99。

## 15. 验收标准

### 15.1 文件与映射

- 虚构 UTF-8 CSV 和 XLSX 可完成预览与导入；
- CSV 引号、逗号、换行和 UTF-8 BOM 由结构化解析器正确处理；
- XLSX 多工作表要求显式选择，不默认猜测；
- 中文别名可以自动映射，冲突映射必须人工确认；
- 空公司、空岗位和超长单元格产生稳定拒绝原因；
- 非法 URL 不会进入 `channelUrl` 或 `officialApplyUrl`。

### 15.2 当前事实与历史

- 成功导入后 `job_leads` 返回最新事实；
- 首次、相同内容、变化内容分别生成 `new/unchanged/changed`；
- A -> B -> A 三个观察均可查询；
- 同一 preview token 或与最近快照相同的文件重复 apply 返回原快照且不重复观察；
- A 文件之后导入 B，再导入 A 时生成第三个快照和第三次观察；
- 文件内完全重复行只导入一次；
- 本次缺失的历史岗位不会被标记为关闭或删除；
- GankInterview 已有岗位和观察仍可读取。

### 15.3 核验和权限

- changed 在同一事务内撤销旧核验并清空 `officialApplyUrl`；
- unchanged 保留 `human_confirmed`；
- 被撤销核验的旧哈希不能进入或恢复批次；
- preview 不写业务事实，apply 未确认不执行；
- 所有导入工具都不访问腾讯网络、BOSS、官网或飞书；
- 测试 fixture 不包含真实个人或岗位数据。

### 15.4 工程验证

- `packages/dsh-plugin` 聚焦测试、全量测试、类型检查和构建通过；
- `boss-watch-agent` 的 `npm test` 和 `npm run check` 通过；
- DSH Skill 能正确区分“最新本地快照”和“实时外部状态”；
- DSH Web 联调能完成：预览 -> 人工确认 -> apply -> 查询当前事实 -> 查询观察历史。

## 16. 交付切片

实现计划应按可独立验收的垂直切片展开：

1. CSV 读取、字段映射和无写入预览；
2. 来源快照、事务 apply 和当前事实更新；
3. 变化分类、核验失效和幂等回归；
4. XLSX 读取与多工作表选择；
5. DSH 工具/Skill、来源状态和端到端联调；
6. 文档、完整验证和测试账号验收手册。

M2.7 完成后再进入 M2.8 官网/ATS 只读 JD 核验。岗位语义匹配、飞书投影和投递页辅助不提前并入
本里程碑。
