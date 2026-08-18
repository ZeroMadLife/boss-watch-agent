# DSH 视觉插件评估与腾讯表格截图降级方案

日期：2026-08-17
状态：正式 profile 已通过图片输入冒烟；截图岗位导入已实现 preview + 确认 apply，落库后仍为未核验来源线索
范围：DSH Web、腾讯文档 Canvas 表格、岗位来源预览

## 1. 结论

腾讯文档当前不能作为稳定的机器读取接口：页面主体由 Canvas 绘制，私有
`/dop-api/opendoc` 请求需要登录态并返回 401，剪贴板也可能被浏览器环境限制。
视觉能力只能解决“看见用户主动提供的截图”，不能解决认证、权限或腾讯私有接口。

当前推荐的最小组合是：

```text
用户人工登录腾讯文档
  -> 用户截取当前可见表格区域 PNG
  -> DSH 图片附件或 read_image
  -> 视觉模型/视觉子代理输出表头、行、置信度
  -> boss_watch_lead_visual_preview（只预览）
  -> 用户确认
  -> 复用 lead snapshot apply（写入 SQLite）
```

第一版只处理当前 viewport，不自动滚动、不点击、不调用腾讯接口、不把截图永久存入岗位事实。

## 2. 社区候选

| 候选 | 本地验证 | 作用 | 当前决策 |
| --- | --- | --- | --- |
| `nexsjournal/dsh-vision-plugin` 1.1.1 | MIT；隔离 Web profile 挂载成功 | 给模型目录增加 `input: [text, image]` 声明；附带可选 BYO 视觉中继 | 暂不加入正式 profile，避免与现有路由重复 |
| `ruby1304/dsh-vision-subagent` 0.3.1 | MIT；typecheck、30 tests、build 全通过；正式 profile 图片冒烟通过 | 文本主模型通过独立视觉路由处理用户主动粘贴的图片 | 正式 profile 使用，配置为 `newapi-vision/gpt-5.6-sol` |
| `Anionex/dsh-vision-toolkit` | 未安装；代码面较大，含后端和运行时安装 | OCR、长截图和图像理解工具集合 | 先不引入，需独立安全审查 |
| `bpc-oss/chrome-faithful` | 只读审查 | 真实 Chrome 截图、OCR、视觉提取 | 权限可触达 Cookie/CDP，不能直接加入正式 profile |

## 3. 已执行的联调

正式 profile：`~/Library/Application Support/BossWatchAgent/dsh`，运行于 DSH Web `3080`。

```text
dsh-vision-subagent     -> DSH Web 3080 -> 插件列表显示“dsh-vision-subagent 已挂载、已启用”
newapi-vision/gpt-5.6-sol -> 图片粘贴桥 -> 主模型回复“视觉输入已收到”
```

对 `dsh-vision-subagent` 执行：

```text
npm ci --ignore-scripts
npm run typecheck       # 通过
npm test                # 5 files / 30 tests 通过
npm run build           # 通过
```

DSH Web 输入框通过粘贴事件接收图片，插件先在独立视觉上下文分析，再把文字结论交给主会话。
主模型是否能直接看图仍由模型目录的 `input: [text, image]` 声明决定；本 profile 选择
`gpt-5.6-sol` 作为视觉主力，并保留 `claude-opus-5` 与 `gpt-5.6-terra` 作为人工切换的备用路由。
`npm run dsh:dev` 会通过 `scripts/dsh-vision-default.patch.yml` 把 `dsh-vision-subagent` 覆盖为
`newapi-vision/gpt-5.6-sol`；如果直接改 profile 的 `cordis.patch.yml`，同样应把 `model` 写成 `gpt-5.6-sol`。

已验证的 NewAPI 模型能力：

| 模型 | 图片请求 | 用途 |
| --- | --- | --- |
| `claude-opus-5` | 通过 | 视觉备用 |
| `gpt-5.6-sol` | 通过 | 视觉主力，复杂截图和表格（默认） |
| `gpt-5.6-terra` | 通过 | 视觉备用/低延迟 |
| `glm-5.2` | 不支持，服务端明确返回文本-only | 不进入视觉路由 |

本地 NewAPI 兼容性还要求所有 OpenAI function 参数 Schema 显式带 `required` 数组；
DSH pi-ai 适配层已将省略字段规范化为 `required: []`，否则模型请求会在工具调用前返回 400。

## 4. 安全边界

视觉插件进入正式 profile 前必须满足：

1. 图片只能来自用户主动上传、拖拽、截图或工作区路径；默认不允许远程 URL。
2. 单图大小、图片数量、问题长度和输出长度有硬上限。
3. 视觉结果只能作为未核验预览，不能自行确认官网链接、岗位状态或投递权限。
4. 低置信度行进入人工核对，不直接写入 `job_leads`。
5. 不保存完整截图到 SQLite；只保存来源引用、字段规范化结果和内容哈希。
6. 视觉模型密钥使用 DSH provider 的凭据引用，不进入 Skill、Transcript、日志或仓库。
7. 任何浏览器登录、验证码、风控和外部提交仍由用户操作。

## 5. 已实现的截图导入工具契约

两个 Host tools 已接入 `boss-watch-dsh-plugin`，命名与现有来源导入保持一致：

### `boss_watch_lead_visual_preview`

- 输入：`sourceRef`、`vision-subagent://` 持久附件引用、视觉模型输出的结构化行、可选列映射。`screenshotHash` 只作为可选断言，Host 会从 DSH attachment store 重新读取并计算真实 SHA-256。
- 行必须至少包含 `company`、`role`；`channelUrl` 只作为来源链接保存。
- `confidence=low` 或数值低于 `0.75` 的行只进入拒绝/人工核对列表，不进入可应用岗位集合。
- URL 含 `...` 或 Unicode `…` 时按视觉截断处理：不保存 `channelUrl`，不使用它做去重锚点，改用公司/届别/招聘类型/岗位字段，并返回 `truncated_channel_url` warning。
- 输出：表头、列映射、接受/拒绝行、低置信度行、最多五行脱敏摘要、截图/映射哈希和 15 分钟 preview token。
- 不写 SQLite，不访问腾讯文档，不接受任意 URL 导航指令。

### `boss_watch_lead_visual_apply`

- 输入：preview token 和用户对来源、行数、低置信度提示的明确确认。
- 重新读取不可变 DSH attachment，校验截图哈希、结构化行/映射哈希和 token 有效期。
- 复用现有 `JobLeadStore` 的 snapshot、幂等、`new/changed/unchanged` 和核验失效逻辑。
- 即使视觉结果被应用，写入的 `confidence` 也只能是 `source_only`，不会自动变成 `url_verified`、`jd_verified` 或 `human_confirmed`。
- 失败时返回稳定错误码，不能部分写入。

该切片不负责 OCR。OCR/视觉识别属于 DSH 视觉插件；业务工具只负责结构化校验、预览和事实落库。
同一截图若视觉模型输出不同的规范化岗位行，会形成不同的 extraction/mapping hash，不会误复用旧快照。

## 6. 正式安装门槛与当前结果

正式 profile 的安装门槛已经满足，当前保留以下回归条件：

1. 只使用明确支持图片的 provider/model；`glm-5.2` 不可作为视觉路由；
2. 用虚构截图验证粘贴、独立视觉分析、主模型回复和失败时草稿保留；
3. 继续补充错误、超限、低置信度和 provider 不可用的降级测试；
4. 运行 `npm test`、`npm run check`、插件 typecheck/build 和 DSH Web smoke；
5. 记录 DSH checkout、插件版本、provider/model 和测试 fixture 哈希。

本切片最新验证：业务插件 `35/35` tests、typecheck、build 通过；主仓 `80/80` tests 和
`npm run check` 通过；重启后的 DSH Web `3080` 返回 HTTP 200，Controller `4318` 返回
`service/database: ready`。真实腾讯表 viewport 的视觉字段准确性仍属于用户体验验收，不计入上述 fixture 结果。
