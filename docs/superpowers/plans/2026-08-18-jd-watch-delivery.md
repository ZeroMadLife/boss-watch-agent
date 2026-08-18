# M3 JD Watch 交付计划

日期：2026-08-18
状态：本地 Watch 核心、一次性到期批次 Scheduler 和结构化 JD Diff 已实现；真实 BOSS 账号验收待完成

## 目标

为已经捕获过完整 BOSS JD 的本地 application 建立可停止、可审计的低频观察目标。M3 的第一阶段只解决
状态持久化、单次 poll 的风险边界和 DSH 调用契约，不把个人账号做成并发爬虫，也不宣称不会触发平台风控。

## 交付范围

- `job_watches`、`job_watch_observations` 和 `job_watch_daily_budget` 三张本地 SQLite 表；
- 只能从已有 application 创建 Watch，使用最近 JD 的固定 `www.zhipin.com/job_detail/<id>.html` URL；
- `boss_watch_watch_create/list/poll/run_due/stop/resume` 六个 DSH Host tools；
- `boss_watch_jd_diff` 只读工具：按本地 Artifact 历史生成有界新增/删除段落，不覆盖原文；
- SQLite 保证的 Profile 级互斥、每日 20 次共享详情观察预算、12/24/48 小时间隔和短暂断连退避；
- 登录、验证码、风控、适配器失配和外部岗位身份不一致进入 `paused_human_required`；
- polling 崩溃后保留 15 分钟恢复窗口，超时允许下一次安全接管，但不在同一轮自动重试；
- DSH Skill 明确创建不 poll、单次显式 poll、到期批次最多 5 个、不循环、不为 `watch_not_due` 自动重试，handoff 后必须显式 resume；
- Loader 装配、工具行为、状态机和浏览器 Controller 客户端回归测试。

## 不在本切片

- 常驻后台 Scheduler、系统通知、Redis/Worker 或跨进程分布式队列；当前只提供显式一次性批次编排；
- 自动发现全站岗位、任意 URL、隐藏接口、代理池、指纹伪造、验证码处理或反爬绕过；
- 自动登录、消息发送、简历投递、官网表单提交或飞书写入；
- 真实账号上的连续低频运行承诺。首次联调必须由用户处理登录、验证码和风险页。

## 状态与预算

```text
active -> polling -> unchanged -> active
                 -> changed -> active
                 -> transient_failure -> active (backoff)
                 -> paused_human_required
active -> stopped
paused_human_required --explicit resume--> active
```

默认规则：changed 后 12h，首次 unchanged 后 24h，连续 unchanged 后 48h；短暂失败从 30min 退避并封顶
6h；所有 Watch 共享 Profile 每日 20 次详情预算。创建和 list 不消耗详情预算。

## 验收证据

- 插件测试：60/60 通过；包含 create 幂等、changed/unchanged、间隔、handoff、每日预算、Profile 互斥、stop/resume、到期批次、结构化 Diff 和真实
  Cordis Loader 工具清单；
- 插件类型检查通过；
- 根仓 `npm test`、`npm run check`、`npm run build` 通过后，才能把 M3 核心标为本地可用；
- 真实账号联调只验证一次固定岗位详情读取、页面身份校验、正常关页或人工暂停，不测并发、不压测、不把
  单次通过写成生产 SLA。

## 下一步

1. 在用户授权的真实账号上执行一次显式 `boss_watch_watch_poll`，记录状态、耗时和内容哈希，不保存 Cookie、
   页面截图或整页日志。
