import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface ApprovalScope {
  sessionId: string;
  conversationId: string;
  recipientId: string;
  contentHash: string;
  expiresAt: number;
}

export type ApprovalVerification =
  | { valid: true }
  | { valid: false; reason: "malformed" | "signature_mismatch" | "scope_mismatch" | "expired" };

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string | undefined {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

function canonicalScope(scope: ApprovalScope): string {
  return JSON.stringify([
    scope.sessionId,
    scope.conversationId,
    scope.recipientId,
    scope.contentHash,
    scope.expiresAt,
  ]);
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function hashMessageContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function issueApprovalToken(scope: ApprovalScope, secret: string): string {
  const payload = encode(canonicalScope(scope));
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyApprovalToken(
  token: string,
  expectedScope: ApprovalScope,
  secret: string,
  now = Date.now(),
): ApprovalVerification {
  const [payload, providedSignature, ...extra] = token.split(".");
  if (!payload || !providedSignature || extra.length > 0) {
    return { valid: false, reason: "malformed" };
  }

  const expectedSignature = signature(payload, secret);
  const providedBytes = Buffer.from(providedSignature, "utf8");
  const expectedBytes = Buffer.from(expectedSignature, "utf8");
  if (providedBytes.length !== expectedBytes.length || !timingSafeEqual(providedBytes, expectedBytes)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  const decoded = decode(payload);
  if (!decoded) {
    return { valid: false, reason: "malformed" };
  }

  let values: unknown;
  try {
    values = JSON.parse(decoded);
  } catch {
    return { valid: false, reason: "malformed" };
  }

  if (
    !Array.isArray(values) ||
    values.length !== 5 ||
    typeof values[0] !== "string" ||
    typeof values[1] !== "string" ||
    typeof values[2] !== "string" ||
    typeof values[3] !== "string" ||
    typeof values[4] !== "number"
  ) {
    return { valid: false, reason: "malformed" };
  }

  const actualScope: ApprovalScope = {
    sessionId: values[0],
    conversationId: values[1],
    recipientId: values[2],
    contentHash: values[3],
    expiresAt: values[4],
  };

  if (actualScope.expiresAt <= now) {
    return { valid: false, reason: "expired" };
  }
  if (canonicalScope(actualScope) !== canonicalScope(expectedScope)) {
    return { valid: false, reason: "scope_mismatch" };
  }
  return { valid: true };
}
