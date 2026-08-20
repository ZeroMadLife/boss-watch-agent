# 闭环投递流程摩擦点与官网投递交接点缺口（2026-08-19 实测，交接给 Codex）

背景：在 DSH 实测 T1–T7 全流程（简历匹配 v3 → Gate A → 官网准备预览 → 人工状态确认 → 飞书同步 → 看板提示），
全程约 30 次工具调用，其中约一半消耗在环境与服务问题诊断上。以下按影响排序。

## A. 已实现闭环的摩擦点

### A1. 4318 本地服务与 DSH/构建不同步（运维，本次最大时间消耗）
- 现象：重建 dist 后旧 serve 进程（08-17 启动）继续跑，新增路由（application-status）认证不匹配，
  插件调用返回 401，诊断花了 ~15 次工具调用。
- 根因：`npm run serve` 是独立常驻进程；DSH 重启不会带它；没有 dist 变更检测或健康检查。
- 建议：serve/DSH 插件启动时做 token 探活（GET /api/v1/browser/status）+ 版本端点，失败明确提示
  "重启 4318 服务"；或提供 `boss-watch serve --check` 自检；README/quickstart 写明"改代码后必须重启 serve"。

### A2. 状态确认与飞书同步都没有批量（确认密度高）
- 现象：status preview/apply、feishu sync preview/apply 都是单 application；批量投递（apply_batch 计划）后
  要逐单确认 N 次；每单还要 Gate A + 状态 + 飞书各确认一次（一次投递 = 3 次确认问答）。
- 建议：`application_status_preview` 支持 applicationIds[]，一个 previewToken 批量 apply；或做"确认汇总页"：
  一次列出 N 单的 Gate A/状态/飞书变更，一次确认。

### A3. 飞书写后回查失败 → 重跑 preview + 再确认一次
- 现象：`feishu_write_record_not_found_after_create`：create 在 API 层成功（远端记录已存在），
  但插件写后回查未匹配 → 抛错、本地投影未保存；第二次 sync_preview 变 update，用户需再确认一次。
- 建议：回查失败时以远端记录为准恢复投影（远端已存在则保存 projection, lastResult=created），
  或错误响应附带可恢复信息（remoteRecordId / 可重放的 previewToken），避免"重跑 + 再确认"。

### A4. 投递时间字段时区/格式漂移 → 永久 diff
- 现象：投影 "2026-08-19 08:15:00"（UTC 字符串），飞书按本地时区解析存为
  "2026-08-19T08:15:00.000+08:00" → 每次 sync 预览都报 diff、永远建议 update；
  且写入的其实是错误时区（比真实时刻早 8 小时）。
- 建议：写入 ISO 带时区（如 ...Z）；diff 比较前先归一化日期；或时间字段只比"意图值"不比存储格式。

### A5. 换简历版本 = 重走 匹配 + Gate A
- 现象：Gate A 哈希绑定旧简历，apply-preview 只接受 leadId+gateAId（无简历参数）→
  想"用最新简历投"必须 import 新版本（supersede）→ 重新 match → 重新 Gate A。
- 建议：简历 import 时若 supersedes 旧版本，自动使依赖旧简历的 Gate A 失效并在看板提示
  "简历已更新，需重新 Gate A"，避免静默用旧简历投。

### A6. 每步一次确认（安全模型正确，但需给用户预期）
- 现象：match 自动写（无需确认）→ gate_a_confirm 1 次 → status 确认 1 次 → feishu 确认 1 次。
- 建议：保持模型，但把确认收敛为"一次确认一个工作单元"（见 A2），工作台显示每单下一步确认点。

### A7. 无"从看板直接执行下一步"入口（可选）
- 看板已有 nextAction/nextTool，agent 每次手动调；可加"执行下一步"按钮生成工具调用草稿。

## B. 官网投递路径缺口（登录/填写/上传/提交目前全部人工）

现状：`boss_watch_apply_preview` 明确 navigation=not_started、form=not_loaded、requiresHuman=true；
`boss_watch_application_form_preview` 只能对"用户已打开"的表单做只读字段分类。
没有任何打开页面、登录检测、填写、上传、提交、结果验证的工具。
边界（AGENTS.md）：登录/QR/验证码/风控永远人工；未经逐岗位 Gate B + 聚焦测试不自动提交。

### B1. 登录交接点（"切点在哪里"）
- 缺口：没有"检测官网登录态"和"等待用户登录完成"的工具。
- 建议契约（对齐 watch/batch 的 pause/resume 模式）：
  - `official_apply_status(leadId)`：只读返回 { pageOpened, loginRequired, formReady, handoffReason? }；
  - 需要登录/验证码/风控 → 返回 handoff_required(login | verification | risk_control)，浏览器交给用户；
  - 用户登录完成后 `official_apply_resume(leadId)` 继续（清 checkpoint，语义同 batch/watch resume）。

### B2. 表单填写交接点（分层，每层一个确认点）
1. 用户已打开页面 → 只读字段分类（已有 application-form-preview-v1）→ 用户确认字段映射；
2. 填写：按绑定简历逐字段填（保留用户审阅），文件上传（简历 PDF 选择）；
3. 不自动提交：最后提交由用户点击，或提交前再次确认 + Gate B 逐岗位批准；
4. 提交后：用户确认页面成功证据 → 记 submitted_observed（对齐 spec，不猜测）。

### B3. 简历版本选择
- 投递用哪版简历 = Gate A 绑定的版本（见 A5）；官网投递入口应显示"将使用简历版本 X（哈希）"，
  若已被 supersede 则阻止并提示重跑匹配。

### B4. 页面身份校验
- 打开/填写前校验 URL hostname == lead.officialApplyUrl hostname（apply-preview 已有雏形），防投错页。

### B5. 批量投递执行
- apply_batch 已有计划框架（prepare/status/resume + paused checkpoint），但"执行"环节
  （逐项打开→登录→填写→提交）未实现；批量时每单登录/风控 handoff 要有明确暂停/继续点，一单失败不阻塞整批。

## 建议优先级
- P0：A1（服务重启一致性，操作事故）、A3（写后回查恢复）、A4（时区漂移，数据正确性）
- P1：A2（批量确认，投递效率）、A5（简历版本失效提示）
- P2：B1–B5（官网投递交接点；先做 B1 登录握手 + B2 字段分类→填写）
