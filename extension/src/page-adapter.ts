import { createPageRevisionPayload, normalizeVisibleText } from "../../src/capture/page-revision.js";

interface SnapshotBase {
  captureId: string;
  capturedAt: string;
  sourceUrl: string;
  pageRevision: string;
}

export type BrowserPageSnapshot =
  | (SnapshotBase & {
      pageKind: "job_detail";
      externalJobId: string;
      company: string;
      role: string;
      description: string;
    })
  | (SnapshotBase & {
      pageKind: "conversation";
      applicationId: string;
      conversationId: string;
      messageId: string;
      recruiterName: string;
      messageText: string;
    });

export type PageAdapterResult =
  | { status: "ready"; snapshot: BrowserPageSnapshot }
  | { status: "application_required" }
  | { status: "unsupported" }
  | { status: "human_required"; reason: "login" | "verification" }
  | { status: "page_adapter_mismatch"; pageKind: "job_detail" | "conversation" };

export async function inspectCurrentPage(
  document: Document,
  sourceUrl: string,
  applicationId?: string,
): Promise<PageAdapterResult> {
  const url = new URL(sourceUrl);
  if (url.protocol !== "https:" || url.hostname !== "www.zhipin.com") return { status: "unsupported" };

  const humanRequired = detectHumanRequired(document);
  if (humanRequired !== undefined) return { status: "human_required", reason: humanRequired };

  const jobMatch = url.pathname.match(/^\/job_detail\/([a-zA-Z0-9_-]+)(?:\.html)?/u);
  if (jobMatch !== null) return inspectJobPage(document, url, jobMatch[1] ?? "");
  if (url.pathname === "/web/geek/chat") return inspectConversationPage(document, url, applicationId);
  return { status: "unsupported" };
}

async function inspectJobPage(
  document: Document,
  url: URL,
  externalJobId: string,
): Promise<PageAdapterResult> {
  const role = firstText(document, [".info-primary .name h1", ".job-banner .name h1", ".name h1"]);
  const description = firstText(document, [
    ".job-sec-text",
    ".job-detail-section .text",
    ".job-detail .job-sec",
  ]);
  const company =
    firstText(document, [
      ".company-info a + a",
      '.company-info a[ka="job-detail-company_custompage"]',
      ".sider-company .company-info a",
      ".job-sider .company-info a",
      ".company-info .company-name",
    ]) || companyFromTitle(document.title);
  if (!role || !description || !company || !externalJobId) {
    return { status: "page_adapter_mismatch", pageKind: "job_detail" };
  }

  const visible = {
    pageKind: "job_detail" as const,
    sourceUrl: normalizedUrl(url),
    externalJobId,
    company,
    role,
    description,
  };
  return {
    status: "ready",
    snapshot: {
      ...visible,
      captureId: crypto.randomUUID(),
      capturedAt: new Date().toISOString(),
      pageRevision: await sha256(createPageRevisionPayload(visible)),
    },
  };
}

async function inspectConversationPage(
  document: Document,
  url: URL,
  applicationId?: string,
): Promise<PageAdapterResult> {
  if (!applicationId) return { status: "application_required" };
  const messageItems = Array.from(document.querySelectorAll<HTMLElement>(".message-item"));
  const messageRoots =
    messageItems.length > 0
      ? messageItems
      : Array.from(document.querySelectorAll<HTMLElement>(".chat-message"));
  const recruiterMessages = messageRoots.filter(
    (element) =>
      !element.classList.contains("is-self") &&
      !element.classList.contains("message-self") &&
      !element.classList.contains("item-myself") &&
      !element.classList.contains("item-system") &&
      element.querySelector(".msg-self") === null &&
      !element.classList.contains("system-message") &&
      element.querySelector(".system-message") === null,
  );
  const latest = recruiterMessages.at(-1);
  if (latest === undefined) return { status: "page_adapter_mismatch", pageKind: "conversation" };
  const messageText =
    firstText(latest, [
      ".msg-text",
      ".message-text",
      ".message-content",
      ".text",
      ".card",
      ".message-card",
    ]) || normalizeVisibleText(latest.innerText || latest.textContent || "");
  const recruiterName =
    firstText(document, [
      ".chat-info .name",
      ".chat-title .name",
      ".friend-content.selected .name-text",
      "li[role=listitem].active .name-text",
      "li[role=listitem][aria-selected=true] .name-text",
    ]) || "当前招聘方";
  if (!messageText) return { status: "page_adapter_mismatch", pageKind: "conversation" };

  const messageId =
    latest.dataset.messageId ||
    latest.dataset.mid ||
    latest.id ||
    `visible-${(await sha256(messageText)).slice(0, 24)}`;
  const selectedConversation = document.querySelector<HTMLElement>(
    ".friend-content.selected, li[role=listitem].active, li[role=listitem][aria-selected=true], .chat-conversation.active",
  );
  const conversationId =
    selectedConversation?.dataset.conversationId ||
    selectedConversation?.dataset.id ||
    `visible-${(await sha256(`${recruiterName}\n${normalizedUrl(url)}`)).slice(0, 24)}`;
  const visible = {
    pageKind: "conversation" as const,
    sourceUrl: normalizedUrl(url),
    conversationId,
    messageId,
    recruiterName,
    messageText,
  };
  return {
    status: "ready",
    snapshot: {
      ...visible,
      applicationId,
      captureId: crypto.randomUUID(),
      capturedAt: new Date().toISOString(),
      pageRevision: await sha256(createPageRevisionPayload(visible)),
    },
  };
}

function detectHumanRequired(document: Document): "login" | "verification" | undefined {
  if (document.querySelector(".login-register-content, .login-dialog, [class*=login-dialog]") !== null)
    return "login";
  if (
    document.querySelector(".captcha, [class*=captcha], [class*=verify-dialog], [class*=security-check]") !==
    null
  ) {
    return "verification";
  }
  return undefined;
}

function firstText(root: ParentNode, selectors: string[]): string {
  for (const selector of selectors) {
    const element = root.querySelector<HTMLElement>(selector);
    const text = normalizeVisibleText(element?.innerText || element?.textContent || "");
    if (text) return text;
  }
  return "";
}

function companyFromTitle(title: string): string {
  return normalizeVisibleText(title.match(/_(.+?)招聘/u)?.[1] ?? "");
}

function normalizedUrl(url: URL): string {
  const normalized = new URL(url);
  normalized.hash = "";
  return normalized.toString();
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
