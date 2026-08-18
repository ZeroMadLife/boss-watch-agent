# M2.7 多来源岗位导入交付计划

来源设计：`docs/superpowers/specs/2026-08-17-job-source-import-and-snapshot-design.md`

状态：Slice 1-6 核心代码、测试、单仓迁移和 DSH Host 加载已完成；待用户从真实腾讯可见区域复制一批数据验收字段映射。

## 仓库边界

- `boss-watch-agent` 是唯一业务仓库。
- DSH 插件源码位于 `packages/dsh-plugin/`，作为业务仓的一部分维护。
- `$DSH_SOURCE_DIR` 是官方 DSH 的独立只读 clone；使用已验证 commit 做兼容测试，不复制到业务仓。
- 只有 DSH 通用问题需要向上游提交 PR 时，才临时为 DSH clone 增加 fork remote。

## Slice 1：单仓插件包与 CSV 解析预览

交付行为：用户将 CSV 放入受控导入目录后，插件工具能识别 UTF-8/BOM、中文表头、有效行和拒绝行，
返回短期预览令牌，不写 `job_leads`。

验收证据：

- 虚构 CSV 的公司、岗位、地点、届别和链接正确映射；
- 缺少公司/岗位的行进入稳定错误报告；
- 路径逃逸、超限文件、错误扩展名被拒绝；
- 预览不创建快照、不创建 observation、不访问外部网络；
- 单仓插件 package 可以独立 typecheck/test/build。

## Slice 2：CSV 确认导入与来源快照

交付行为：用户确认有效预览后，apply 在一个 SQLite 事务中写入 `job_source_snapshots`、当前 `job_leads`
和有效行的 `job_lead_observations`。

验收证据：

- apply 前重新校验 fileHash、mappingHash、来源和预览有效期；
- 数据库异常时整批回滚，不生成成功快照；
- `new / unchanged / changed` 计数与现有 Gank 语义一致；
- 当前候选池立即能读到最新腾讯导入事实。

## Slice 3：幂等、变化与核验失效

交付行为：重复预览/导入不重复写事实；内容变化撤销旧核验；A -> B -> A 历史可追溯。

验收证据：

- 同一 preview token 重试返回原 snapshotId；
- 与最近成功快照完全相同的文件重试不新增 observation；
- A、B、A 产生三个快照和三个观察；
- changed 同事务清空 `officialApplyUrl`、退回 `source_only` 并标记核验失效；
- 旧 leadContentHash 不能进入批次 Gate B。

## Slice 4：XLSX 与来源状态

交付行为：支持多工作表 XLSX 的显式选择、公式/宏不执行、来源状态只读查询。

验收证据：

- 多工作表未指定时返回 `sheet_selection_required`；
- 选定工作表可以完成预览和导入；
- 公式单元格不被求值；
- `boss_watch_source_status` 只读本地快照，不访问腾讯文档或 Gank。

## Slice 5：DSH Skill、联调与交付文档

交付行为：DSH 能区分“最新本地快照”和“实时外部状态”，完成 preview -> confirmation -> apply -> list -> observation。

验收证据：

- 工具全部使用 `boss_watch_` 前缀并声明副作用；
- Skill 明确 CSV/XLSX 是用户按需导入，不是后台同步；
- 插件测试、主仓 `npm test`、`npm run check`、构建和 DSH Web smoke 通过；
- README、DSH 本地开发文档和测试账号手册反映单仓插件路径。

## Slice 6：查看权限剪贴板快照

交付行为：用户无法导出腾讯表时，选中可见表格区域并复制；DSH 先预览本机剪贴板，再经用户确认复用
现有来源快照事务写入 SQLite。

验收证据：

- 默认解析浏览器复制产生的 TSV，兼容 CSV；
- 预览不写岗位事实，完整剪贴板内容不进入 DSH transcript；
- 只返回字段映射、统计、拒绝行号和最多五行脱敏摘要；
- apply 前重新读取剪贴板并核对哈希，变化时返回 `clipboard_changed_since_preview`；
- 空剪贴板与不可用系统剪贴板返回稳定错误，不访问腾讯文档网络；
- 临时明文文件在 apply、失败或预览过期后删除。

## 实施约束

- 先写失败测试，再实现最小行为；
- 测试只用虚构岗位和 URL；
- 不提交真实导出文件、凭据或 SQLite 数据库；
- 不引入 Redis、Worker 池或外部写入；
- 每个 slice 完成后运行该 slice 的聚焦测试，再继续下一 slice。
