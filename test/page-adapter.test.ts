import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";
import { inspectCurrentPage } from "../extension/src/page-adapter.js";

beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
});

describe("BOSS current-page adapter", () => {
  it("extracts only the explicit job fields from a job detail fixture", async () => {
    const dom = new JSDOM(`
      <title>「AI Agent 工程师」_示例科技招聘</title>
      <main>
        <section class="info-primary"><div class="name"><h1>AI Agent 工程师</h1></div></section>
        <section class="job-sec-text">负责构建可审计的 Agent 工作流。</section>
        <aside class="sider-company"><div class="company-info"><a>示例科技</a></div></aside>
        <script>window.__SECRET__ = "must-not-be-captured"</script>
      </main>
    `);

    const result = await inspectCurrentPage(
      dom.window.document,
      "https://www.zhipin.com/job_detail/demo-job-001.html#tracking",
    );

    expect(result).toMatchObject({
      status: "ready",
      snapshot: {
        pageKind: "job_detail",
        externalJobId: "demo-job-001",
        company: "示例科技",
        role: "AI Agent 工程师",
        description: "负责构建可审计的 Agent 工作流。",
        sourceUrl: "https://www.zhipin.com/job_detail/demo-job-001.html",
        pageRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-be-captured");
  });

  it("extracts fields from the current BOSS job layout (company-info block, logo + name anchors)", async () => {
    const dom = new JSDOM(`
      <title>「JAVA开发工程师（医务系统）」_亿同科技招聘</title>
      <main>
        <div class="company-info">
          <div class="name"><h1>JAVA开发工程师（医务系统）</h1></div>
        </div>
        <div class="company-info">
          <a ka="job-detail-company-logo_custompage" href="/gongsi/demo-company.html" title="亿同科技">
            <img src="https://img.example/logo.png" alt="">
          </a>
          <a ka="job-detail-company_custompage" href="/gongsi/demo-company.html" title="亿同科技">亿同科技</a>
        </div>
        <section class="job-sec-text">负责医务系统产品开发与单元测试。</section>
      </main>
    `);

    const result = await inspectCurrentPage(
      dom.window.document,
      "https://www.zhipin.com/job_detail/8c02d02447609e000nd929y7EVRT.html",
    );

    expect(result).toMatchObject({
      status: "ready",
      snapshot: {
        pageKind: "job_detail",
        externalJobId: "8c02d02447609e000nd929y7EVRT",
        company: "亿同科技",
        role: "JAVA开发工程师（医务系统）",
        description: "负责医务系统产品开发与单元测试。",
      },
    });
  });

  it("returns only the latest non-self message from the selected conversation", async () => {
    const dom = new JSDOM(`
      <ul><li role="listitem" class="active" data-conversation-id="conversation-001">
        <span class="name-text">招聘顾问</span>
      </li></ul>
      <section class="chat-content">
        <div class="message-item" data-message-id="message-001"><p class="message-text">你好</p></div>
        <div class="message-item is-self" data-message-id="message-002"><p class="message-text">您好</p></div>
        <div class="message-item" data-message-id="message-003"><p class="message-text">方便发一份简历吗？</p></div>
      </section>
    `);

    const result = await inspectCurrentPage(
      dom.window.document,
      "https://www.zhipin.com/web/geek/chat",
      "application-demo-001",
    );

    expect(result).toMatchObject({
      status: "ready",
      snapshot: {
        pageKind: "conversation",
        applicationId: "application-demo-001",
        conversationId: "conversation-001",
        messageId: "message-003",
        recruiterName: "招聘顾问",
        messageText: "方便发一份简历吗？",
      },
    });
  });

  it("handles the live BOSS chat message classes and ignores self/system cards", async () => {
    const dom = new JSDOM(`
      <ul>
        <li role="listitem">
          <div class="friend-content selected">
            <span class="name-text">招聘顾问</span>
          </div>
        </li>
      </ul>
      <section class="chat-content">
        <li class="message-item item-system" data-mid="system-001">
          <div class="message-content">系统自动匹配职位</div>
        </li>
        <li class="message-item item-myself" data-mid="self-001">
          <div class="message-content">我的自我介绍</div>
        </li>
        <li class="message-item item-friend" data-mid="friend-001">
          <div class="message-content">方便聊聊这个岗位吗？</div>
        </li>
      </section>
    `);

    const result = await inspectCurrentPage(
      dom.window.document,
      "https://www.zhipin.com/web/geek/chat",
      "application-demo-001",
    );

    expect(result).toMatchObject({
      status: "ready",
      snapshot: {
        pageKind: "conversation",
        recruiterName: "招聘顾问",
        messageId: "friend-001",
        messageText: "方便聊聊这个岗位吗？",
      },
    });
    expect(JSON.stringify(result)).not.toContain("我的自我介绍");
    expect(JSON.stringify(result)).not.toContain("系统自动匹配职位");
  });

  it("hands login and verification pages back to the user", async () => {
    const login = new JSDOM(`<div class="login-dialog">扫码登录</div>`);
    const verification = new JSDOM(`<div class="captcha">安全验证</div>`);

    await expect(
      inspectCurrentPage(login.window.document, "https://www.zhipin.com/web/geek/chat", "application-1"),
    ).resolves.toEqual({ status: "human_required", reason: "login" });
    await expect(
      inspectCurrentPage(
        verification.window.document,
        "https://www.zhipin.com/job_detail/demo.html",
        "application-1",
      ),
    ).resolves.toEqual({ status: "human_required", reason: "verification" });
  });

  it("returns a bounded mismatch diagnostic when supported page structure drifts", async () => {
    const dom = new JSDOM(`<main>未知的新页面结构以及不应回传的整页内容</main>`);

    await expect(
      inspectCurrentPage(dom.window.document, "https://www.zhipin.com/job_detail/demo.html"),
    ).resolves.toEqual({ status: "page_adapter_mismatch", pageKind: "job_detail" });
  });
});
