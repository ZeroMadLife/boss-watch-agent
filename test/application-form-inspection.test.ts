import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import {
  APPLICATION_FORM_INSPECTION_EXPRESSION,
  BossBrowserRunController,
  type BossHunterBrowserRuntime,
} from "../src/browser/browser-run-controller.js";

const officialUrl = "https://careers.example.invalid/jobs/agent/apply?session=redacted";

function runtime(overrides: Partial<BossHunterBrowserRuntime> = {}): BossHunterBrowserRuntime {
  return {
    async health() {
      return { status: "ok", runtime: "bosshunter", connected: true };
    },
    async targets() {
      return [{ targetId: "official-form-target", type: "page", title: "虚构招聘表单", url: officialUrl }];
    },
    async evaluate() {
      return {
        status: "ready",
        sourceUrl: officialUrl,
        title: "虚构招聘表单",
        fields: [
          {
            ordinal: 0,
            controlType: "email",
            inputType: "email",
            label: "邮箱",
            name: "candidate_email",
            autocomplete: "email",
            required: true,
            disabled: false,
            readOnly: false,
            currentState: "present",
          },
        ],
      };
    },
    async newTab() {
      return "unused";
    },
    async close() {},
    ...overrides,
  };
}

function controller(browserRuntime: BossHunterBrowserRuntime): BossBrowserRunController {
  return new BossBrowserRunController({ runtime: browserRuntime, captureJob: vi.fn() });
}

describe("official application form inspection", () => {
  it("extracts visible field metadata without returning current values", () => {
    const dom = new JSDOM(
      `<!doctype html><title>虚构 ATS</title><form>
      <label for="name">姓名</label><input id="name" name="candidate_name" value="候选人甲" required>
      <label for="email">邮箱</label><input id="email" type="email" value="secret@example.invalid" autocomplete="email">
      <label><input type="checkbox" name="privacy" checked> 同意隐私条款</label>
      <label for="resume">上传简历</label><input id="resume" type="file" name="resume">
      <input type="hidden" name="csrf" value="secret-token">
    </form>`,
      {
        url: officialUrl,
        runScripts: "outside-only",
      },
    );

    const result = dom.window.eval(APPLICATION_FORM_INSPECTION_EXPRESSION) as {
      status: string;
      fields: Array<Record<string, unknown>>;
    };
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("ready");
    expect(result.fields).toHaveLength(4);
    expect(result.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "姓名", controlType: "text", currentState: "present" }),
        expect.objectContaining({ label: "邮箱", controlType: "email", autocomplete: "email" }),
        expect.objectContaining({ controlType: "checkbox", currentState: "checked" }),
        expect.objectContaining({ label: "上传简历", controlType: "file", currentState: "empty" }),
      ]),
    );
    expect(serialized).not.toContain("候选人甲");
    expect(serialized).not.toContain("secret@example.invalid");
    expect(serialized).not.toContain("secret-token");
  });

  it("hands password and verification pages back to the user", () => {
    const login = new JSDOM('<form><input type="password"></form>', {
      url: "https://careers.example.invalid/login",
      runScripts: "outside-only",
    });
    const verification = new JSDOM('<main><div class="captcha-panel">verify</div></main>', {
      url: officialUrl,
      runScripts: "outside-only",
    });

    expect(login.window.eval(APPLICATION_FORM_INSPECTION_EXPRESSION)).toMatchObject({
      status: "human_required",
      reason: "login",
    });
    expect(verification.window.eval(APPLICATION_FORM_INSPECTION_EXPRESSION)).toMatchObject({
      status: "human_required",
      reason: "verification",
    });
  });

  it("binds inspection to the verified origin and redacts query parameters", async () => {
    const result = await controller(runtime()).inspectApplicationForm(
      "https://careers.example.invalid/jobs/agent#apply",
    );

    expect(result).toMatchObject({
      status: "ready",
      targetCount: 1,
      page: {
        pageKind: "application_form",
        title: "虚构招聘表单",
        url: "https://careers.example.invalid/jobs/agent/apply",
        hostname: "careers.example.invalid",
        formHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        metadataTrust: "untrusted_page",
      },
      fields: [
        {
          fieldId: expect.stringMatching(/^form-field:[a-f0-9]{64}$/u),
          metadataTrust: "untrusted_page",
          currentState: "present",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("session=redacted");
  });

  it("fails closed for invalid origins, missing pages, ambiguous tabs, and identity drift", async () => {
    const evaluate = vi.fn();
    await expect(
      controller(runtime({ evaluate })).inspectApplicationForm("https://127.0.0.1/apply"),
    ).resolves.toEqual({
      status: "invalid_request",
      reason: "unsupported_official_url",
      targetCount: 0,
    });
    expect(evaluate).not.toHaveBeenCalled();

    await expect(
      controller(
        runtime({
          async targets() {
            return [{ targetId: "other", type: "page", url: "https://other.example.invalid/apply" }];
          },
        }),
      ).inspectApplicationForm("https://careers.example.invalid/apply"),
    ).resolves.toEqual({
      status: "no_supported_tab",
      reason: "official_page_not_open",
      targetCount: 0,
    });

    await expect(
      controller(
        runtime({
          async targets() {
            return [
              { targetId: "one", type: "page", url: "https://careers.example.invalid/apply/1" },
              { targetId: "two", type: "page", url: "https://careers.example.invalid/apply/2" },
            ];
          },
        }),
      ).inspectApplicationForm("https://careers.example.invalid/apply"),
    ).resolves.toEqual({
      status: "target_ambiguous",
      reason: "multiple_official_tabs",
      targetCount: 2,
    });

    await expect(
      controller(
        runtime({
          async evaluate() {
            return {
              status: "ready",
              sourceUrl: "https://attacker.example.invalid/apply",
              fields: [
                {
                  ordinal: 0,
                  controlType: "text",
                  inputType: "text",
                  label: "字段",
                  required: false,
                  disabled: false,
                  readOnly: false,
                  currentState: "empty",
                },
              ],
            };
          },
        }),
      ).inspectApplicationForm("https://careers.example.invalid/apply"),
    ).resolves.toEqual({
      status: "human_required",
      reason: "page_identity_mismatch",
      targetCount: 1,
    });
  });
});
