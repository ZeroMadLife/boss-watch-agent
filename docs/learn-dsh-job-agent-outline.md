# Learn DSH with a Job Agent：学习博客方案

状态：本地草稿，未发布
目标：用一个真实但安全的求职 Agent 贯穿 DSH 学习，不把教学玩具冒充 DSH 本体实现。

## 定位

参考 [onychen/learn-dsh](https://github.com/onychen/learn-dsh) 的“先跑、再观察、再解释”结构，内容从 DSH 的最小机制开始，最后落到 `boss-watch-dsh-plugin`。博客不是 DSH 官方文档，也不是 BOSS 自动投递教程。

每课固定八段：

1. Motto：本课只解决一个问题；
2. 30 秒运行：默认 Replay，不需要 API Key；
3. 观察输出：记录事实，不先下结论；
4. 问题：为什么需要这一层；
5. 心智模型：用一个小例子建立直觉；
6. 方案与图：画执行链或状态变化；
7. 代码拆解：对照 DSH 官方源码；
8. 真实差异：说明教学代码省略了什么。

## 课程地图

### A. Agent 与 Cordis

- L01：最小 Agent Loop：一次请求、一次工具、一次结果；
- L02：Cordis Plugin：不改核心，挂载并可撤销；
- L03：Context、Service、Effect：能力放在哪里；
- L04：事件分发：观察、拦截和策略不是同一类事件。

### B. Session 与证据

- L05：Session Event 是追加日志；
- L06：消息投影：模型看到的内容如何从日志派生；
- L07：Turn / Step：模型请求和工具调用的边界；
- L08：Trace 查看：为什么能回放一次 Agent 行为。

### C. Tool、Skill 与安全

- L09：Tool Registry：工具定义、参数 schema 和规范输出；
- L10：Tool 执行管线：pre、guard、execute、post；
- L11：Skill 不是权限：知识提示与动作策略分离；
- L12：Capability seam：provider、存储和浏览器适配可替换。

### D. 异步能力

- L13：Skills 按需加载；
- L14：Jobs 与后台任务；
- L15：Goal 是状态，不是隐式调度器；
- L16：Subagent 上下文隔离与结果回传。

### E. 产品组装

- L17：Profile 与 Bundle：一组插件如何组成产品；
- L18：Host Plugin 与 Client Plugin；
- L19：`connection.rpc`：Web UI 到 Host 的结构化通道；
- L20：DSH Web 启动链路和本地 profile。

### F. 求职 Agent 纵向案例

- L21：岗位、JD、投递事件和面经的领域模型；
- L22：`boss_watch_capture_current_job`：原文、哈希、幂等和导出；
- L23：Browser Controller：DSH 如何通过受控工具连接 BossHunter CDP Runtime；
- L24：盯盘 Agent 原理：ExecutionPlan、Skill/ReAct、Fresh Capture、ActionGuard、Checkpoint 和 Handoff；
- L25：风险确认：为什么发送、投递、面试接受必须人工审批；
- L26：Side Panel 兼容入口：为什么页面调试入口不等于 Agent 主链路；
- L27：Capstone：把 `boss-watch-dsh-plugin` 装进 DSH Web。

## 面试表达对照

这套项目可以这样解释，且不超出当前实现证据：

> 我们没有把 DSH 改成一个任意浏览器控制器，而是把求职能力做成独立插件。DSH 负责目标理解、计划和工具调用；
> Browser Controller 负责连接已登录 Chrome、固定页面适配、来源白名单、Fresh Capture 和人工接管；BossHunter
> 只提供本地 CDP Runtime；SQLite 负责可审计事实。Skill 优先处理确定性页面流程，页面漂移时才把当前步骤交给
> ReAct，且每轮只允许一个受控动作。登录、验证码、风控和所有外部写入始终停在人工 Gate。

与 HR Agent Platform Watch 的关系要明确说成“借鉴通用控制思想，不声称复刻其平台能力”：

| HR Agent 原理 | 本项目对应实现 | 当前边界 |
| --- | --- | --- |
| Run Contract / ExecutionPlan | DSH Skill 和 Browser Controller 调用契约 | 当前实现岗位卡片发现、受控详情读取，尚未实现长期 Watch 调度 |
| Browser Skill | 固定 BOSS 页面提取器与业务工具 | 不向模型暴露 CSS、URL 或 JavaScript |
| ReAct fallback | 设计中的页面漂移回退点 | M2 尚未开放模型 ReAct 浏览器动作 |
| Fresh Capture | 读取目标页后重新校验 URL、岗位 ID 和页面版本 | 发现结果通过临时详情页读取，捕获后自动关闭；页面漂移回 `page_adapter_mismatch` |
| ActionGuard | loopback 服务身份、BOSS 域名白名单、发现结果 ID、临时详情页和人工 Handoff | 只读能力，不包含发送/投递 Guard |
| Checkpoint / Handoff | `environment_interrupted`、`human_required` 稳定状态 | 低频 Watch 和恢复队列属于后续切片 |

“已实现”指代码和自动化测试已覆盖；“待真实账号验收”指需要用户已登录 Chrome 的现场验证；
“设计中”不能包装成 P99、生产吞吐或自动投递成功率。

## 教学工程约束

- 默认 Replay，任何真实模型调用都必须显式打开；
- 课程 fixture 使用虚构姓名、岗位和 URL；
- 教学代码与真实 DSH 包使用表格映射，明确简化点；
- 不放 cookies、token、简历、聊天导出或真实截图；
- 每课配一个可运行命令和一个最小测试；
- 任何发送类动作只展示 approval gate，不连接真实发送端点；
- 文章先在本地审阅，不自动发布。

## 目录草案

```text
learn-dsh-job-agent/
  README.md
  lessons/
    L01-agent-loop/README.zh.md
    L01-agent-loop/main.ts
    ...
  shared/
    replay-model.ts
    fixture-data.ts
  site/
    README.md
    build-site.ts
  docs/
    source-map.md
    safety-boundary.md
```

Markdown 是唯一内容源；静态站点只是构建产物。不要一开始引入数据库、账号系统或在线编辑器。

## 第一阶段发布条件

先完成 L01-L04 和一个 `boss-watch-dsh-plugin` 只读工具示例，满足以下条件后才考虑 GitHub 公开发布：

- 每课可以脱网运行；
- 代码、讲义和输出互相对应；
- 真实 DSH 源码链接可访问；
- 明确标注“设计中/已实现/已测量”；
- 安全边界经过一次人工审阅。
