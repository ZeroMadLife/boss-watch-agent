# Feishu 单向投影实施计划

目标：实现已批准 Spec 中的 Feishu Base 接入、半自动字段映射、只读同步预览、显式确认应用和本地幂等映射。

## Slice 1：可测试的 Feishu Connector 边界

- 新增 `FeishuClient` 接口，覆盖 URL resolve、Base/table schema、record list、record create/update。
- 新增 `LarkCliFeishuClient`，通过 `execFile` 调用 `lark-cli`，固定 `--as user`，只解析 JSON stdout，stderr 不进入业务结果。
- 所有命令参数使用数组传递，不拼接 shell；限制输出大小、超时和记录页大小。
- 为 CLI 错误映射 `feishu_url_unresolvable`、`feishu_resource_forbidden`、`feishu_schema_changed` 等稳定错误。
- 用假客户端 fixture 覆盖成功、权限不足、非法 JSON、超时和非零退出。

## Slice 2：Feishu Target 与字段映射 SQLite 存储

- 新增 `FeishuTargetStore` 和 SQLite 表：`feishu_targets`、`feishu_target_mappings`、`feishu_projections`。
- 保存资源 ID、身份、schemaHash、映射版本和更新时间，不保存 Cookie、OAuth token 或页面原文。
- 映射器按字段名、类型、单选选项生成候选映射；公司/岗位为最小必需语义字段。
- 映射冲突、类型不兼容、只读字段和缺少身份键进入 warning/conflict，不自动写入。
- 测试内存 SQLite/临时文件迁移、重复 target、schema 变化和关闭后错误。

## Slice 3：DSH Target Preview/Confirm 工具

- 新增 `boss_watch_feishu_target_preview`：解析链接、读取结构、返回脱敏字段和候选映射，只读。
- 新增 `boss_watch_feishu_target_confirm`：绑定 preview token 和当前 schemaHash，将映射写入本地 SQLite。
- preview token 绑定 session、资源、身份、schemaHash、映射和过期时间；不把 token 写入日志。
- 更新 Skill：用户给链接后先 preview，确认后才保存 target；权限不足只展示只读结果。
- 更新 loader/tool schema 测试和 Skill 文本测试。

## Slice 4：同步 Preview 与 Projection 计划

- 将本地 Application/JobLead 转换为目标字段 map，只写可写且已映射字段。
- 分页读取目标表的最小字段集合，按 `remoteRecordId`、业务键、岗位链接、公司+岗位+城市匹配。
- 生成 `create/update/unchanged/conflict/warnings`，记录 field diff 和 source fact hash。
- 新增 `boss_watch_feishu_sync_preview`，生成 15 分钟短期 preview token。
- 测试重复预览稳定性、已有记录匹配、空链接回退、多个候选冲突和敏感字段裁剪。

## Slice 5：显式 Apply 与幂等回写

- 新增 `boss_watch_feishu_sync_apply`，必须携带 preview token 和精确确认字符串/布尔确认。
- 重新读取 schema 和必要记录，发现事实、映射或 schema 变化立即拒绝并要求重新预览。
- 更新使用保存的 `remoteRecordId`；创建成功后写入 `feishu_projections`；同一 apply 重试返回原结果。
- 同一表串行写入，单批不超过 200；外部错误只写 projection result，不改变 SQLite 事实。
- 测试未确认拒绝、过期 token、schema 变化、重复 apply、写入失败和部分成功恢复。

### Slice 5.1：CLI 回执兼容与写后对账（已完成）

- `+record-list` 同时兼容旧的 `items/records` 对象数组，以及当前 CLI 返回的
  `data + field_id_list + record_id_list` 平行数组。
- `+record-upsert` 成功但没有返回 `record_id` 时，不把写入判为失败；客户端改为只读分页回查，
  按岗位链接优先、公司+岗位回退做唯一匹配。
- 回查到零条或多条候选时失败关闭，分别返回稳定错误，不重复执行 upsert。
- URL 单元格统一归一化裸 URL 与 Feishu Markdown 链接，避免写后回查和已有记录匹配出现假冲突。
- 投影服务在 `unchanged` apply 时也保存本地 `applicationId -> remoteRecordId`，可恢复一次“远端已写入、
  本地 projection 缺失”的状态。

## Slice 6：真实测试 Base 验收与文档

- 使用专用测试记录或测试 Base，不直接批量修改真实投递数据。
- 执行 target preview -> confirm -> sync preview -> explicit apply -> repeat sync 的完整链路。
- 读取回写结果，只核对测试记录；保留 Feishu 记录 ID 和投影哈希，不保存敏感内容。
- 更新 `docs/job-search-agent-spec.md`、Skill 使用说明、测试账号快速开始文档。
- 验收后再考虑将目标配置暴露到 DSH 求职中心；本轮不做后台轮询和双向同步。

## 验证命令

```bash
npm run dsh:plugin:test
npm run dsh:plugin:check
npm run dsh:plugin:build
npm test
npm run check
```

执行真实 Feishu apply 前必须由用户明确确认目标表、预览统计和待写字段；测试阶段默认只运行 read/preview。
