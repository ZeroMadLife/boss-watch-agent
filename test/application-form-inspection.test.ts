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

function controller(
  browserRuntime: BossHunterBrowserRuntime,
  allowedResumeRoot?: string,
): BossBrowserRunController {
  return new BossBrowserRunController({ runtime: browserRuntime, captureJob: vi.fn(), allowedResumeRoot });
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

  it("recognizes accessible custom comboboxes and only exposes bounded option labels", () => {
    const dom = new JSDOM(
      `<!doctype html><title>虚构 ATS</title><form>
      <div class="form-item"><label id="degree-label">最高学历</label>
        <button type="button" role="combobox" aria-labelledby="degree-label" aria-haspopup="listbox" aria-expanded="true">请选择</button>
      </div>
      <div role="listbox"><div role="option" data-value="master">硕士研究生</div><div role="option" data-value="bachelor">大学本科</div></div>
    </form>`,
      { url: officialUrl, runScripts: "outside-only" },
    );

    const result = dom.window.eval(APPLICATION_FORM_INSPECTION_EXPRESSION) as {
      status: string;
      fields: Array<Record<string, unknown>>;
    };

    expect(result.status).toBe("ready");
    expect(result.fields).toEqual([
      expect.objectContaining({
        controlType: "combobox",
        label: "最高学历",
        currentState: "empty",
        options: [
          { label: "硕士研究生", value: "master" },
          { label: "大学本科", value: "bachelor" },
        ],
      }),
    ]);
  });

  it("selects an exact custom option and reports a next-step handoff", async () => {
    const dom = new JSDOM(
      `<!doctype html><form>
      <div class="form-item"><label id="degree-label">最高学历</label>
        <button id="degree" type="button" role="combobox" aria-labelledby="degree-label" aria-controls="degrees">请选择</button>
      </div>
      <div id="degrees" role="listbox"><button type="button" role="option" data-value="master">硕士研究生</button></div>
      <button type="button">下一步</button>
      </form>`,
      { url: officialUrl, runScripts: "outside-only" },
    );
    dom.window.document.querySelector('[role="option"]')?.addEventListener("click", (event) => {
      const option = event.currentTarget as HTMLElement;
      const combobox = dom.window.document.querySelector("#degree");
      if (combobox !== null) combobox.textContent = option.textContent;
    });
    const formController = controller(
      runtime({
        async evaluate(_targetId, expression) {
          return dom.window.eval(expression) as unknown;
        },
      }),
    );
    const inspected = await formController.inspectApplicationForm(officialUrl);
    if (inspected.status !== "ready") throw new Error("expected_ready_form");
    const degree = inspected.fields[0];
    if (degree === undefined) throw new Error("missing_degree_field");
    const filled = await formController.fillApplicationForm({
      expectedUrl: officialUrl,
      expectedFormHash: inspected.page.formHash,
      fields: [{ fieldId: degree.fieldId, value: "硕士" }],
    });

    expect(filled).toEqual(
      expect.objectContaining({ status: "filled", filledCount: 1, nextAction: "next_step_handoff" }),
    );
    expect(dom.window.document.querySelector("#degree")?.textContent).toBe("硕士研究生");
  });

  it("uses bounded education aliases for a native select", async () => {
    const dom = new JSDOM(
      `<!doctype html><form>
      <label for="degree">最高学历</label>
      <select id="degree" name="degree">
        <option value="">请选择</option>
        <option value="master">硕士研究生</option>
        <option value="bachelor">大学本科</option>
      </select>
      <button type="submit">提交</button>
      </form>`,
      { url: officialUrl, runScripts: "outside-only" },
    );
    const formController = controller(
      runtime({
        async evaluate(_targetId, expression) {
          return dom.window.eval(expression) as unknown;
        },
      }),
    );
    const inspected = await formController.inspectApplicationForm(officialUrl);
    if (inspected.status !== "ready") throw new Error("expected_ready_form");
    const degree = inspected.fields[0];
    if (degree === undefined) throw new Error("missing_degree_field");

    const filled = await formController.fillApplicationForm({
      expectedUrl: officialUrl,
      expectedFormHash: inspected.page.formHash,
      fields: [{ fieldId: degree.fieldId, value: "硕士" }],
    });

    expect(filled).toEqual(
      expect.objectContaining({ status: "filled", filledCount: 1, nextAction: "review_before_submit" }),
    );
    expect((dom.window.document.querySelector("#degree") as HTMLSelectElement | null)?.value).toBe("master");
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

  it("fills an exact standard-form plan without checking consent or submitting", async () => {
    let submitCount = 0;
    const dom = new JSDOM(
      `<!doctype html><title>虚构 ATS</title><form id="application-form">
      <label for="name">姓名</label><input id="name" name="candidate_name" required>
      <label for="email">邮箱</label><input id="email" type="email" name="candidate_email" autocomplete="email">
      <label for="city">所在城市</label><select id="city" name="city"><option value="">请选择</option><option value="shanghai">上海</option></select>
      <label><input id="consent" type="checkbox" name="privacy"> 同意隐私条款</label>
      <button type="submit">提交</button>
    </form>`,
      { url: officialUrl, runScripts: "outside-only" },
    );
    dom.window.document.querySelector("form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      submitCount += 1;
    });
    const browserRuntime = runtime({
      async evaluate(_targetId, expression) {
        return dom.window.eval(expression) as unknown;
      },
    });
    const formController = controller(browserRuntime);
    const inspected = await formController.inspectApplicationForm(officialUrl);
    expect(inspected.status).toBe("ready");
    if (inspected.status !== "ready") throw new Error("expected_ready_form");
    const fieldByLabel = new Map(inspected.fields.map((field) => [field.label, field]));
    const name = fieldByLabel.get("姓名");
    const email = fieldByLabel.get("邮箱");
    const city = fieldByLabel.get("所在城市");
    if (name === undefined || email === undefined || city === undefined)
      throw new Error("missing_fixture_fields");

    const filled = await formController.fillApplicationForm({
      expectedUrl: officialUrl,
      expectedFormHash: inspected.page.formHash,
      fields: [
        { fieldId: name.fieldId, value: "候选人甲" },
        { fieldId: email.fieldId, value: "private@example.invalid" },
        { fieldId: city.fieldId, value: "上海" },
      ],
    });

    expect(filled).toMatchObject({
      status: "filled",
      filledCount: 3,
      filledFieldIds: [name.fieldId, email.fieldId, city.fieldId],
      requiresHumanReview: true,
      submitted: false,
    });
    expect((dom.window.document.querySelector("#name") as HTMLInputElement).value).toBe("候选人甲");
    expect((dom.window.document.querySelector("#email") as HTMLInputElement).value).toBe(
      "private@example.invalid",
    );
    expect((dom.window.document.querySelector("#city") as HTMLSelectElement).value).toBe("shanghai");
    expect((dom.window.document.querySelector("#consent") as HTMLInputElement).checked).toBe(false);
    expect(submitCount).toBe(0);
    expect(JSON.stringify(filled)).not.toContain("private@example.invalid");
    expect(JSON.stringify(filled)).not.toContain("候选人甲");
  });

  it("uploads one hash-bound resume from the controlled root and stops before submit", async () => {
    const resumeRoot = await mkdtemp(join(tmpdir(), "boss-watch-form-upload-"));
    const resumePath = join(resumeRoot, "resume.pdf");
    const bytes = Buffer.from("fictional resume fixture");
    await writeFile(resumePath, bytes);
    const setFiles = vi.fn(async () => undefined);
    const dom = new JSDOM(
      '<form><label for="resume">上传简历</label><input id="resume" type="file"><button type="submit">提交</button></form>',
      { url: officialUrl, runScripts: "outside-only" },
    );
    try {
      const formController = controller(
        runtime({
          async evaluate(_targetId, expression) {
            return dom.window.eval(expression) as unknown;
          },
          setFiles,
        }),
        resumeRoot,
      );
      const inspected = await formController.inspectApplicationForm(officialUrl);
      if (inspected.status !== "ready") throw new Error("expected_ready_form");
      const file = inspected.fields[0];
      if (file === undefined) throw new Error("missing_file_field");
      const result = await formController.fillApplicationForm({
        expectedUrl: officialUrl,
        expectedFormHash: inspected.page.formHash,
        fields: [],
        resumeUpload: {
          fieldId: file.fieldId,
          filePath: resumePath,
          contentHash: createHash("sha256").update(bytes).digest("hex"),
        },
      });

      expect(result).toMatchObject({
        status: "filled",
        filledCount: 0,
        uploadedResume: true,
        nextAction: "review_before_submit",
        submitted: false,
      });
      expect(setFiles).toHaveBeenCalledWith("official-form-target", 'input[type="file"]', [resumePath]);
    } finally {
      await rm(resumeRoot, { recursive: true, force: true });
    }
  });

  it("does not mutate the page when the form hash changed after preview", async () => {
    const dom = new JSDOM(
      '<form><label for="name">姓名</label><input id="name" name="candidate_name"></form>',
      { url: officialUrl, runScripts: "outside-only" },
    );
    const formController = controller(
      runtime({
        async evaluate(_targetId, expression) {
          return dom.window.eval(expression) as unknown;
        },
      }),
    );
    const inspected = await formController.inspectApplicationForm(officialUrl);
    expect(inspected.status).toBe("ready");
    if (inspected.status !== "ready") throw new Error("expected_ready_form");
    const field = inspected.fields[0];
    if (field === undefined) throw new Error("missing_fixture_field");
    dom.window.document
      .querySelector("form")
      ?.insertAdjacentHTML("beforeend", '<label for="extra">新增问题</label><input id="extra" name="extra">');

    await expect(
      formController.fillApplicationForm({
        expectedUrl: officialUrl,
        expectedFormHash: inspected.page.formHash,
        fields: [{ fieldId: field.fieldId, value: "候选人甲" }],
      }),
    ).resolves.toMatchObject({ status: "conflict", reason: "form_changed" });
    expect((dom.window.document.querySelector("#name") as HTMLInputElement).value).toBe("");
  });
});

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
