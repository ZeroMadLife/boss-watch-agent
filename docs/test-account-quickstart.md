# Boss Watch 测试账号试用手册

先按本机 checkout 设置路径：

```bash
export BOSS_WATCH_DIR=/path/to/boss-watch-agent
export BOSS_HUNTER_DIR=/path/to/BossHunter
```

日期：2026-08-17
适用版本：M2 DSH Browser Controller

## 1. 准备

- Node.js `>=22.19.0`
- Google Chrome
- 用户有权使用的 BOSS 测试账号

登录、扫码、验证码和平台风险提示必须由用户在 Chrome 中人工处理。Boss Watch 不读取 Cookie、密码、
Local Storage 或网络请求头。

## 2. 启动 BossHunter Browser Runtime

DSH 通过 BossHunter 的本地 CDP Bridge 连接 Chrome，不需要加载扩展。先让 Chrome 使用可调试的测试
Profile，并由用户完成 BOSS 登录、扫码和验证码；这些步骤始终人工完成。

```bash
cd $BOSS_HUNTER_DIR
node src/bosshunter/browser/runtime/check-runtime.mjs
```

确认 `http://127.0.0.1:3456/health` 返回 `runtime=bosshunter`。`connected=false` 可能只是首次读取前
的瞬时状态；Controller 调用 `/targets` 时会主动建立连接。只有 `/targets` 请求失败，才需要按
BossHunter 的运行说明启动或恢复远程调试 Chrome。

## 3. 构建并启动本地服务

```bash
cd $BOSS_WATCH_DIR
npm install
npm run build
npm run serve
```

服务终端可能显示：

```text
Boss Watch listening at http://127.0.0.1:4318
Analysis mode: baseline_ready (Pi model is not configured)
Pairing code: 123456 (expires ...)
```

DSH 主链路不需要配对码；配对码只属于旧的扩展兼容入口，不是 DSH 求职看板或表单流程的前置条件。服务会自动创建
`~/Library/Application Support/BossWatchAgent/dsh-service-token`，权限为 `0600`，不打印令牌。
终端和本地服务必须保持运行。

## 4. DSH 岗位捕获验收

1. 人工在 Chrome 中打开 BOSS 岗位列表、搜索结果或推荐页，只保留一个 BOSS 标签页。
2. 启动 DSH Web：

   ```bash
   cd $BOSS_WATCH_DIR
   npm run dsh:dev
   ```

3. 在 `http://127.0.0.1:3080/` 配置可用模型（启动脚本默认不会自动打开新窗口），新建对话并输入：

   ```text
   请调用 boss_watch_discover_jobs，读取当前 BOSS 页面可见的岗位卡片，不打开详情页。
   ```

4. 返回岗位卡片后，选择一个 `externalJobId` 并输入：

   ```text
   请使用刚才返回的 discoveryId 和 externalJobId 调用 boss_watch_capture_discovered_job，
   打开并保存这个岗位的完整 JD，只写本地事实，不发送或投递。
   ```

5. 再调用一次，确认返回同一个 `applicationId/eventId` 且 `deduplicated=true`。

如果用户已经位于唯一岗位详情页，仍可直接调用 `boss_watch_browser_status` 和
`boss_watch_capture_current_job`，无需先执行发现。

## 5. Side Panel 兼容验收（可选）

如果需要测试招聘方聊天捕获或页面适配器，可继续加载 `$BOSS_WATCH_DIR/dist/extension`。
扩展配对只影响这条兼容入口，不影响 DSH 的岗位捕获链路。

## 6. 验收聊天捕获

1. 先通过 DSH 完成至少一个岗位捕获。
2. 人工进入 BOSS 聊天页并选中测试会话。
3. 在 Side Panel 选择要关联的本地投递。
4. 点击“保存并分析”。
5. 确认 Side Panel 展示最后一条可见招聘方原文、意图和回复草稿。

规则分析显示为 `Baseline`，草稿只能复制，没有发送按钮。V1 不滚动加载聊天历史，也不扫描其他联系人。

## 7. 时间线和导出

Side Panel 的“时间线”显示当前 `applicationId` 的证据事件。完整 JSON 或 Markdown 由用户显式导出：

```bash
npm run export -- \
  --db "$HOME/Library/Application Support/BossWatchAgent/boss-watch.sqlite3" \
  --out ./exports/applications.json \
  --format json
```

导出不会自动上传飞书或其他外部服务。默认拒绝覆盖已有文件；确认覆盖时增加 `--force`。

## 8. DSH 事实查询验收

完成一条岗位捕获后，在 DSH Web 中输入：

```text
请调用 boss_watch_job_list，列出本地已捕获岗位；若失败请保留工具返回的原始状态。
```

预期结果是看到刚刚保存的岗位、`applicationId`、捕获时间和内容哈希。继续用该 ID 验证：

```text
请调用 boss_watch_job_get 和 boss_watch_application_timeline，查询 applicationId 为 <上一步返回的 ID> 的本地事实。
```

如需查看进度摘要：

```text
请调用 boss_watch_application_overview，查询 applicationId 为 <ID> 的本地求职进度，不执行外部动作。
```

如需验收本地跟进收件箱：

```text
请为 applicationId 为 <ID> 的岗位安排 2026-08-20 09:00 的本地跟进提醒，原因是 no_response，不发送任何消息。
然后调用 boss_watch_follow_up_list，按 2026-08-21T00:00:00.000Z 查看待跟进项。
处理完后调用 boss_watch_follow_up_complete 关闭刚才的 followUpId。
```

这条链路只写同一个 SQLite 的 `application_follow_ups` 表；完成提醒不代表已经联系招聘方。

如需验收免登录的辅助进度信号，可以粘贴一段虚构招聘通知，或用输入栏回形针按钮选择虚构 `.eml/.txt`：

```text
请为 applicationId 为 <ID> 的岗位预览这条招聘进度信号，只做本地分类，不写 SQLite 或飞书。
```

确认返回的 application、来源、内容哈希和提议后，再明确要求调用 `boss_watch_progress_signal_apply`。
该链路最多追加本地证据和状态提议；官网/ATS 当前状态通常仍需人工登录核验，飞书同步仍需单独确认。

事实查询工具只读取 SQLite；批次 `prepare` / `resume` 只写入本地批次状态，不会打开 BOSS、填写表单、发送消息、投递简历或写入飞书。未启动本地服务或未捕获岗位时，若数据库不存在，工具应返回 `source_unavailable`；这不是空岗位列表。

## 9. 从岗位到投递的 DSH 闭环

日常使用不需要记工具名。可以直接在 DSH 输入框说：

```text
请处理这个岗位：安克创新
内推链接：https://example.invalid/referral
内推码：DEMO123
先判断是否值得投；值得的话再用当前简历准备官网投递。登录、验证码和最终提交都交给我，投递完成后再记录进度。
```

DSH 按以下顺序停在每个人工边界：

1. 预览并保存来源；用户在官网中选定确切岗位，补充完整 JD，确认公司、岗位和链接。
2. 用本地简历和完整 JD 做脱敏匹配，展示分数、能力证据、缺口和地点偏好；用户明确确认“值得投”后才建立 Gate A。
3. 生成官网投递准备预览，固定使用 Gate A 绑定的简历版本。用户点击“打开投递入口”，遇到登录、扫码、验证码或风控时人工处理。
4. 登录完成后，在同源唯一表单直接说“填当前页”。DSH 会一次扫描并填写确定性字段、兼容下拉，同时向唯一简历控件上传 Gate A 绑定版本；不会逐字段反复确认。
5. 用户检查结果，补充未识别字段，按页面需要手工点击下一步并再次说“继续填当前页”；隐私协议和最终提交始终由用户完成。DSH 不把“预填完成”说成“已投递”。
6. 用户告诉 DSH“已投递/完成笔试/收到面试”等事实，DSH 先生成状态预览；确认后追加本地时间线，再生成飞书同步预览，用户再次确认才写入多维表格。

验收时准备一条已核验官网岗位和一份本地 PDF/DOCX 简历即可。先验证按钮选择、输入区粘贴或拖拽能生成简历导入草稿，再验证匹配是否可解释、登录 handoff 后能否继续、当前页预填是否受 session/form hash 约束且不回显个人值、Gate A 简历是否上传到唯一文件控件、证件/健康/政治字段与协议/提交是否仍留给人工，以及提交后状态是否能进入本地看板和 Feishu 预览。

批次工具当前要求候选已经是 `jd_verified` 或 `human_confirmed`。在 DSH 中可以这样验收本地状态契约（使用数据库里已核验的 `leadId`）：

```text
请按我给出的 leadId 顺序调用 boss_watch_apply_batch_prepare，只创建本地批次，不打开网页、不填写、不投递。
然后调用 boss_watch_apply_batch_status，展示 batchId、岗位顺序和每个 itemState。
```

如果某岗位遇到登录、验证码或风控，系统会保存 `handoff_required` checkpoint；用户处理完后必须明确说明“已处理”，再调用
`boss_watch_apply_batch_resume`。恢复只会清除旧 Gate B 并回到 `awaiting_gate_b`，不会自动重试或提交。

## 10. 常见状态

| 状态 | 处理方式 |
| --- | --- |
| 本地服务未启动 | 在仓库运行 `npm run serve` |
| 配对码过期或锁定 | 停止并重新启动本地服务 |
| 当前页面不受支持 | 切换到岗位详情页或聊天页 |
| `target_ambiguous` | 关闭其他岗位详情标签页，只保留一个 |
| `environment_interrupted` | 检查 3456 Runtime、Chrome 调试和 4318 服务 |
| 请先人工登录/验证 | 在 BOSS 页面人工完成后刷新 |
| 页面结构暂未识别 | 记录脱敏页面类型和错误状态，不提交页面原文或截图 |
| Pi 模型尚未配置 | 使用明确标识的 Baseline；Pi Provider 后续单独配置 |
| `port_in_use:4318` | 用 `lsof -nP -iTCP:4318 -sTCP:LISTEN` 确认占用进程 |

## 11. 反馈记录

测试账号验收只记录：页面类型、成功/失败状态、错误码、端到端时延和证据哈希。不要把真实 Cookie、
手机号、简历、聊天导出、测试数据库或未脱敏截图加入 Git。
