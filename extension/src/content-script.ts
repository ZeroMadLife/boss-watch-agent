import { inspectCurrentPage } from "./page-adapter.js";

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isCaptureRequest(message)) return false;
  inspectCurrentPage(document, window.location.href, message.applicationId)
    .then(sendResponse)
    .catch(() => sendResponse({ status: "page_adapter_mismatch", pageKind: pageKindFromLocation() }));
  return true;
});

function isCaptureRequest(value: unknown): value is { type: "BOSS_WATCH_INSPECT"; applicationId?: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "BOSS_WATCH_INSPECT" &&
    (record.applicationId === undefined || typeof record.applicationId === "string")
  );
}

function pageKindFromLocation(): "job_detail" | "conversation" {
  return window.location.pathname === "/web/geek/chat" ? "conversation" : "job_detail";
}
