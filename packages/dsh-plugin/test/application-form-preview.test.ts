import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { CallId } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { LocalApplicationFormPreviewService } from "../src/application-form-preview.ts";
import type { LocalAtsAutofillProfileService } from "../src/ats-autofill-profile.ts";
import type { CandidateProfileStore } from "../src/candidate-profile.ts";
import type {
  BossWatchBrowserController,
  BossWatchDataSource,
  BrowserApplicationFormField,
} from "../src/domain.ts";
import type { GateAApproval, GateAStore } from "../src/gate-a.ts";
import type { JobLead, JobLeadStore } from "../src/job-lead.ts";
import type { RecruitmentSourceStore } from "../src/recruitment-source.ts";
import type { ResumeVersion, ResumeVersionStore } from "../src/resume-version.ts";
import { registerBossWatchTools } from "../src/tools.ts";

const LEAD: JobLead = {
  leadId: "lead:fixture:form-preview",
  sourceKind: "company_career_site",
  sourceRecordId: "form-preview",
  company: "虚构科技",
  role: "Agent 平台工程师",
  city: "深圳",
  officialApplyUrl: "https://careers.example.invalid/jobs/agent?session=redacted",
  fetchedAt: "2026-08-18T04:00:00.000Z",
  rawRef: "fixture://lead/form-preview",
  contentHash: "a".repeat(64),
  confidence: "human_confirmed",
};

const RESUME: ResumeVersion = {
  resumeVersionId: `resume-version:${"b".repeat(64)}`,
  displayName: "候选人简历 v1",
  localArtifactRef: `local-resume://sha256:${"b".repeat(64)}`,
  contentHash: "b".repeat(64),
  mediaType: "application/pdf",
  byteSize: 2048,
  createdAt: "2026-08-18T04:10:00.000Z",
};

const GATE_A: GateAApproval = {
  gateAId: `gate-a:${"d".repeat(64)}`,
  matchId: `resume-match:${"e".repeat(64)}`,
  applicationId: "application-fixture-form-preview",
  resumeVersionId: RESUME.resumeVersionId,
  jdContentHash: "f".repeat(64),
  resumeContentHash: RESUME.contentHash,
  matchStrategyVersion: "local-evidence-match-v3",
  approvedAt: "2026-08-18T04:30:00.000Z",
  decision: "proceed_to_material_preparation",
  externalAction: "not_authorized",
};

const CANDIDATE_PROFILE = {
  profileId: "candidate-profile:default" as const,
  strategyVersion: "candidate-profile-v1" as const,
  updatedAt: "2026-08-20T04:00:00.000Z",
  contentHash: "9".repeat(64),
  values: {
    arrivalTime: "两周内",
    wechat: "candidate_wechat",
    internshipDuration: "6个月",
  },
};

function formField(
  ordinal: number,
  label: string,
  controlType: BrowserApplicationFormField["controlType"] = "text",
  extra: Partial<BrowserApplicationFormField> = {},
): BrowserApplicationFormField {
  return {
    fieldId: `form-field:${String(ordinal).padStart(64, "0")}`,
    ordinal,
    controlType,
    inputType: controlType,
    label,
    required: true,
    disabled: false,
    readOnly: false,
    currentState: "empty",
    metadataTrust: "untrusted_page",
    ...extra,
  };
}

function browser(
  result: Awaited<ReturnType<BossWatchBrowserController["inspectApplicationForm"]>>,
): BossWatchBrowserController {
  return {
    async status() {
      return { status: "no_supported_tab", reason: "no_boss_page", targetCount: 0 };
    },
    async captureCurrentJob() {
      return { status: "no_supported_tab", reason: "no_boss_page", targetCount: 0 };
    },
    async discoverJobs() {
      return { status: "no_supported_tab", reason: "no_boss_page", targetCount: 0 };
    },
    async captureDiscoveredJob() {
      return { status: "invalid_request", reason: "job_not_found", targetCount: 0 };
    },
    async pollJob() {
      return { status: "invalid_request", reason: "job_not_found", targetCount: 0 };
    },
    async inspectApplicationForm() {
      return result;
    },
    async fillApplicationForm(input) {
      return {
        status: "filled",
        targetCount: 1,
        page: READY_FORM.page,
        formHash: READY_FORM.page.formHash,
        filledFieldIds: input.fields.map((field) => field.fieldId),
        filledCount: input.fields.length,
        requiresHumanReview: true,
        submitted: false,
      };
    },
  };
}

const READY_FORM = {
  status: "ready" as const,
  targetCount: 1 as const,
  page: {
    pageKind: "application_form" as const,
    title: "虚构申请表",
    url: "https://careers.example.invalid/jobs/agent/apply",
    hostname: "careers.example.invalid",
    formHash: "c".repeat(64),
    metadataTrust: "untrusted_page" as const,
  },
  fields: [
    formField(0, "姓名", "text", { autocomplete: "name" }),
    formField(1, "电子邮箱", "email", { autocomplete: "email" }),
    formField(2, "手机号码", "tel", { autocomplete: "tel" }),
    formField(3, "上传简历", "file"),
    formField(4, "性别", "select"),
    formField(5, "同意隐私条款", "checkbox"),
    formField(6, "自定义问题", "textarea"),
    formField(7, "申请岗位", "text"),
    formField(8, "职位关键字", "text"),
    formField(9, "意向城市", "text"),
    formField(10, "到岗时间", "text"),
    formField(11, "微信号", "text"),
    formField(12, "可实习时长", "text"),
  ],
};

function service(
  input: {
    form?: typeof READY_FORM | { status: "human_required"; reason: "verification"; targetCount: 1 };
    readText?: () => Promise<never>;
    readArtifact?: () => Promise<{
      resumeVersion: ResumeVersion;
      filePath: string;
      sourceByteHash: string;
    }>;
    browser?: BossWatchBrowserController;
    profile?: ReturnType<CandidateProfileStore["get"]>;
    atsProfiles?: Pick<LocalAtsAutofillProfileService, "getOrCreate">;
  } = {},
): LocalApplicationFormPreviewService {
  return new LocalApplicationFormPreviewService({
    leads: { get: () => LEAD },
    resumes: { get: () => RESUME },
    resumeImport: {
      readText:
        input.readText ??
        (async () => ({
          resumeVersion: RESUME,
          text: "姓名：候选人甲\n邮箱：private@example.invalid\n手机：13800000000\n现居地：上海\n示例大学 计算机技术 硕士 2027届\n专业技能 Java Python Redis",
          extractionStatus: "text_extracted",
          characterCount: 112,
          sourceByteHash: RESUME.contentHash,
        })),
      ...(input.readArtifact === undefined ? {} : { readArtifact: input.readArtifact }),
    },
    browser: input.browser ?? browser(input.form ?? READY_FORM),
    ...(input.atsProfiles === undefined ? {} : { atsProfiles: input.atsProfiles }),
    approvals: { get: () => GATE_A } as Pick<GateAStore, "get">,
    recruitmentSources: {
      list: () => [
        {
          sourceId: "recruitment-source:fixture-form-preview",
          company: LEAD.company,
          channelUrl: LEAD.officialApplyUrl,
          rawTextHash: "1".repeat(64),
          rawTextLength: 80,
          capturedAt: "2026-08-18T04:00:00.000Z",
          status: "jd_ready",
          boundLeadId: LEAD.leadId,
          boundApplicationId: GATE_A.applicationId,
          jdContentHash: GATE_A.jdContentHash,
        },
      ],
    } as unknown as Pick<RecruitmentSourceStore, "list">,
    candidateProfiles: { get: () => input.profile ?? CANDIDATE_PROFILE } as Pick<
      CandidateProfileStore,
      "get"
    >,
    now: () => new Date("2026-08-18T05:00:00.000Z"),
  });
}

test("fills the current page in one authorized operation and returns only a compact review result", async () => {
  let inspectedCount = 0;
  let filledCount = 0;
  const controller = browser(READY_FORM);
  controller.inspectApplicationForm = async () => {
    inspectedCount += 1;
    return READY_FORM;
  };
  controller.fillApplicationForm = async (input) => {
    filledCount += 1;
    return {
      status: "filled",
      targetCount: 1,
      page: READY_FORM.page,
      formHash: READY_FORM.page.formHash,
      filledFieldIds: input.fields.map((field) => field.fieldId),
      filledCount: input.fields.length,
      requiresHumanReview: true,
      submitted: false,
      uploadedResume: false,
      nextAction: "review_before_submit",
    };
  };
  const formService = service({ browser: controller });

  const result = await formService.autofill({
    leadId: LEAD.leadId,
    gateAId: GATE_A.gateAId,
    sessionId: "dsh-session-autofill",
    authorization: "fill_current_page",
  });

  assert.equal(inspectedCount, 1);
  assert.equal(filledCount, 1);
  assert.equal(result.status, "filled");
  if (result.status !== "filled") throw new Error("expected_filled_autofill");
  assert.equal(result.company, "虚构科技");
  assert.equal(result.role, "Agent 平台工程师");
  assert.equal(result.filledCount, 9);
  assert.equal(result.unresolvedCount, 4);
  assert.equal(result.submitted, false);
  assert.equal(result.nextAction, "review_before_submit");
  assert.match(result.planContentHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(result.authorization, {
    action: "fill_current_page",
    boundToCurrentSession: true,
    expiresAt: "2026-08-18T05:15:00.000Z",
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("private@example.invalid"), false);
  assert.equal(serialized.includes("13800000000"), false);
  assert.equal(serialized.includes("candidate_wechat"), false);
});

test("plans only dropdown values that have a bounded compatible option", async () => {
  const selectForm = {
    ...READY_FORM,
    fields: [
      formField(0, "姓名"),
      formField(1, "最高学历", "select", {
        options: [
          { label: "请选择", value: "" },
          { label: "硕士研究生", value: "master" },
        ],
      }),
      formField(2, "毕业时间", "select", {
        options: [
          { label: "请选择", value: "" },
          { label: "6月", value: "06" },
        ],
      }),
    ],
  };
  const outcome = await service({ form: selectForm as typeof READY_FORM }).preview({
    leadId: LEAD.leadId,
    gateAId: GATE_A.gateAId,
    sessionId: "dsh-session-select-plan",
  });

  assert.equal(outcome.status, "ready");
  if (outcome.status !== "ready") throw new Error("expected_ready_preview");
  assert.deepEqual(
    outcome.preview.fields.map((field) => [field.semantic, field.plannedAction]),
    [
      ["full_name", "fill"],
      ["education", "fill"],
      ["graduation_year", "manual"],
    ],
  );
});

test("uses labels to distinguish birth, arrival, and graduation date controls", async () => {
  const dateForm = {
    ...READY_FORM,
    fields: [
      formField(0, "出生日期", "date"),
      formField(1, "到岗时间", "date"),
      formField(2, "毕业时间", "month"),
    ],
  };
  const outcome = await service({ form: dateForm as typeof READY_FORM }).preview({
    leadId: LEAD.leadId,
    gateAId: GATE_A.gateAId,
    sessionId: "dsh-session-date-semantics",
  });

  assert.equal(outcome.status, "ready");
  if (outcome.status !== "ready") throw new Error("expected_ready_preview");
  assert.deepEqual(
    outcome.preview.fields.map((field) => [field.semantic, field.plannedAction]),
    [
      ["birth_date", "manual"],
      ["arrival_time", "manual"],
      ["graduation_year", "manual"],
    ],
  );
});

test("builds a Gate A bound reusable prefill plan without exposing profile values", async () => {
  const outcome = await service().preview({
    leadId: LEAD.leadId,
    gateAId: GATE_A.gateAId,
    sessionId: "dsh-session-fixture",
  });
  assert.equal(outcome.status, "ready");
  if (outcome.status !== "ready") throw new Error("expected_ready_preview");
  assert.equal(outcome.preview.strategyVersion, "application-form-prefill-v2");
  assert.equal(outcome.preview.readOnly, true);
  assert.equal(outcome.preview.externalAction, "not_started");
  assert.equal(outcome.preview.requiresOneShotApproval, true);
  assert.equal(outcome.preview.gateA.gateAId, GATE_A.gateAId);
  assert.equal(outcome.preview.resume.resumeVersionId, GATE_A.resumeVersionId);
  assert.deepEqual(
    {
      fillStrategy: outcome.preview.profile.fillStrategy,
      modelCalls: outcome.preview.profile.modelCalls,
      browserCallsAfterApproval: outcome.preview.profile.browserCallsAfterApproval,
    },
    {
      fillStrategy: "deterministic_dom_batch",
      modelCalls: 0,
      browserCallsAfterApproval: 1,
    },
  );
  assert.deepEqual(outcome.preview.profile.availableSemantics, [
    "full_name",
    "email",
    "phone",
    "location",
    "school",
    "major",
    "education",
    "graduation_year",
    "skills",
    "position_keywords",
    "preferred_city",
    "arrival_time",
    "wechat",
    "internship_duration",
  ]);
  assert.equal(outcome.preview.lead.officialApplyUrl, "https://careers.example.invalid/jobs/agent");
  assert.deepEqual(
    outcome.preview.fields.map((field) => [
      field.semantic,
      field.category,
      field.source,
      field.plannedAction,
    ]),
    [
      ["full_name", "resume_available", "resume", "fill"],
      ["email", "sensitive", "resume", "fill"],
      ["phone", "sensitive", "resume", "fill"],
      ["resume_file", "resume_available", "resume", "manual"],
      ["gender", "sensitive", "none", "manual"],
      ["consent", "needs_user_input", "none", "manual"],
      ["unknown", "unknown", "none", "manual"],
      ["target_role", "resume_available", "job_lead", "fill"],
      ["position_keywords", "resume_available", "job_lead", "fill"],
      ["preferred_city", "resume_available", "job_lead", "fill"],
      ["arrival_time", "resume_available", "candidate_profile", "fill"],
      ["wechat", "sensitive", "candidate_profile", "fill"],
      ["internship_duration", "resume_available", "candidate_profile", "fill"],
    ],
  );
  assert.deepEqual(outcome.preview.summary, {
    fieldCount: 13,
    resumeAvailableCount: 7,
    needsUserInputCount: 1,
    sensitiveCount: 4,
    unknownCount: 1,
    alreadyPresentCount: 0,
    fillableCount: 9,
    manualCount: 4,
    uploadCount: 0,
  });
  const serialized = JSON.stringify(outcome);
  assert.equal(serialized.includes("private@example.invalid"), false);
  assert.equal(serialized.includes("[PHONE_REDACTED]"), false);
  assert.equal(serialized.includes("候选人甲"), false);
  assert.equal(serialized.includes("13800000000"), false);
  assert.equal(serialized.includes("session=redacted"), false);
});

test("uploads only the Gate A bound resume artifact without exposing its local path", async () => {
  let fillInput: Parameters<NonNullable<BossWatchBrowserController["fillApplicationForm"]>>[0] | undefined;
  const controlledPath = "/controlled/resumes/.artifacts/resume.pdf";
  const uploadBrowser = browser(READY_FORM);
  uploadBrowser.fillApplicationForm = async (input) => {
    fillInput = input;
    return {
      status: "filled",
      targetCount: 1,
      page: READY_FORM.page,
      formHash: READY_FORM.page.formHash,
      filledFieldIds: input.fields.map((field) => field.fieldId),
      filledCount: input.fields.length,
      requiresHumanReview: true,
      submitted: false,
      uploadedResume: true,
      nextAction: "review_before_submit",
    };
  };
  const formService = service({
    browser: uploadBrowser,
    readArtifact: async () => ({
      resumeVersion: RESUME,
      filePath: controlledPath,
      sourceByteHash: RESUME.contentHash,
    }),
  });
  const preview = await formService.preview({
    leadId: LEAD.leadId,
    gateAId: GATE_A.gateAId,
    sessionId: "dsh-session-upload",
  });
  assert.equal(preview.status, "ready");
  if (preview.status !== "ready") throw new Error("expected_ready_preview");
  assert.equal(preview.preview.lead.company, "虚构科技");
  assert.equal(preview.preview.lead.role, "Agent 平台工程师");
  assert.equal(
    preview.preview.fields.find((field) => field.semantic === "resume_file")?.plannedAction,
    "upload",
  );
  assert.equal(preview.preview.summary.uploadCount, 1);
  assert.equal(JSON.stringify(preview).includes(controlledPath), false);

  const result = await formService.apply({
    previewToken: preview.preview.previewToken,
    sessionId: "dsh-session-upload",
  });
  assert.equal(result.status, "filled");
  assert.equal(result.status === "filled" && result.uploadedResume, true);
  assert.deepEqual(fillInput?.resumeUpload, {
    fieldId: READY_FORM.fields[3]?.fieldId,
    filePath: controlledPath,
    contentHash: RESUME.contentHash,
  });
});

test("fills only the exact previewed fields and rejects a different DSH session", async () => {
  const formService = service();
  const outcome = await formService.preview({
    leadId: LEAD.leadId,
    gateAId: GATE_A.gateAId,
    sessionId: "dsh-session-fixture",
  });
  assert.equal(outcome.status, "ready");
  if (outcome.status !== "ready") throw new Error("expected_ready_preview");

  await assert.rejects(
    formService.apply({
      previewToken: outcome.preview.previewToken,
      sessionId: "other-session",
    }),
    /application_form_preview_session_mismatch/u,
  );
  const applied = await formService.apply({
    previewToken: outcome.preview.previewToken,
    sessionId: "dsh-session-fixture",
  });
  assert.deepEqual(applied, {
    status: "filled",
    leadId: LEAD.leadId,
    gateAId: GATE_A.gateAId,
    formHash: READY_FORM.page.formHash,
    filledFieldIds: READY_FORM.fields
      .filter((field) => [0, 1, 2, 7, 8, 9, 10, 11, 12].includes(field.ordinal))
      .map((field) => field.fieldId),
    filledCount: 9,
    manualReviewRequired: true,
    submitted: false,
    uploadedResume: false,
    nextAction: "review_before_submit",
  });
  assert.equal(JSON.stringify(applied).includes("private@example.invalid"), false);
  await assert.rejects(
    formService.apply({
      previewToken: outcome.preview.previewToken,
      sessionId: "dsh-session-fixture",
    }),
    /application_form_preview_consumed/u,
  );
});

test("returns handoff without reading the resume when the page needs verification", async () => {
  let read = false;
  const outcome = await service({
    form: { status: "human_required", reason: "verification", targetCount: 1 },
    readText: async () => {
      read = true;
      throw new Error("must_not_read");
    },
  }).preview({ leadId: LEAD.leadId, gateAId: GATE_A.gateAId, sessionId: "dsh-session-fixture" });

  assert.deepEqual(outcome, {
    status: "handoff_required",
    reason: "verification",
    browserStatus: "human_required",
    targetCount: 1,
    detail: "verification",
  });
  assert.equal(read, false);
});

test("exposes preview and one-shot confirmed local fill through dedicated DSH tools", async () => {
  const context = new Context();
  await context.plugin(SystemPrompt);
  await context.plugin(ToolRuntime);
  const source: BossWatchDataSource = {
    async listJobs() {
      return [];
    },
    async listApplicationOverviews() {
      return [];
    },
    async getApplicationOverview() {
      return undefined;
    },
    async getJob() {
      return undefined;
    },
    async listTimeline() {
      return [];
    },
  };
  const controller = browser(READY_FORM);
  const formPreview = service();
  const dispose = registerBossWatchTools(
    context,
    source,
    controller,
    undefined,
    { get: () => LEAD } as unknown as JobLeadStore,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { get: () => RESUME } as unknown as ResumeVersionStore,
    undefined,
    undefined,
    undefined,
    formPreview,
  );
  try {
    const autofill = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId("application-form-autofill-tool"),
      name: "boss_watch_application_form_autofill",
      arguments: {
        leadId: LEAD.leadId,
        gateAId: GATE_A.gateAId,
        authorization: "fill_current_page",
      },
      agent: { id: "dsh-session-fixture" } as never,
    });
    const autofillContent = autofill.content[0];
    if (autofillContent?.type !== "text") throw new Error("expected_text_tool_result");
    const autofillPayload = JSON.parse(autofillContent.text) as {
      status: string;
      result: { company: string; role: string; filledCount: number; submitted: boolean };
    };
    assert.equal(autofillPayload.status, "ok");
    assert.deepEqual(
      {
        company: autofillPayload.result.company,
        role: autofillPayload.result.role,
        filledCount: autofillPayload.result.filledCount,
        submitted: autofillPayload.result.submitted,
      },
      {
        company: "虚构科技",
        role: "Agent 平台工程师",
        filledCount: 9,
        submitted: false,
      },
    );
    assert.equal(autofillContent.text.includes("private@example.invalid"), false);

    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId("application-form-preview-tool"),
      name: "boss_watch_application_form_preview",
      arguments: { leadId: LEAD.leadId, gateAId: GATE_A.gateAId },
      agent: { id: "dsh-session-fixture" } as never,
    });
    const content = result.content[0];
    if (content?.type !== "text") throw new Error("expected_text_tool_result");
    const payload = JSON.parse(content.text) as { status: string; preview: { strategyVersion: string } };
    assert.equal(payload.status, "ok");
    assert.equal(payload.preview.strategyVersion, "application-form-prefill-v2");

    const previewPayload = JSON.parse(content.text) as { preview: { previewToken: string } };
    const rejected = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId("application-form-fill-tool-rejected"),
      name: "boss_watch_application_form_fill_apply",
      arguments: { previewToken: previewPayload.preview.previewToken, confirmed: false },
      agent: { id: "dsh-session-fixture" } as never,
    });
    const rejectedContent = rejected.content[0];
    if (rejectedContent?.type !== "text") throw new Error("expected_text_tool_result");
    assert.deepEqual(JSON.parse(rejectedContent.text), {
      status: "invalid_request",
      message: "application_form_fill_confirmation_required",
    });

    const applied = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId("application-form-fill-tool-confirmed"),
      name: "boss_watch_application_form_fill_apply",
      arguments: { previewToken: previewPayload.preview.previewToken, confirmed: true },
      agent: { id: "dsh-session-fixture" } as never,
    });
    const appliedContent = applied.content[0];
    if (appliedContent?.type !== "text") throw new Error("expected_text_tool_result");
    const appliedPayload = JSON.parse(appliedContent.text) as {
      status: string;
      result: { status: string; submitted: boolean; manualReviewRequired: boolean; filledCount: number };
    };
    assert.deepEqual(appliedPayload, {
      status: "ok",
      result: {
        status: "filled",
        leadId: LEAD.leadId,
        gateAId: GATE_A.gateAId,
        formHash: READY_FORM.page.formHash,
        filledFieldIds: READY_FORM.fields
          .filter((field) => [0, 1, 2, 7, 8, 9, 10, 11, 12].includes(field.ordinal))
          .map((field) => field.fieldId),
        filledCount: 9,
        manualReviewRequired: true,
        submitted: false,
        uploadedResume: false,
        nextAction: "review_before_submit",
      },
    });
    assert.equal(appliedContent.text.includes("private@example.invalid"), false);
    assert.equal(appliedContent.text.includes("13800000000"), false);
  } finally {
    dispose();
    await context.fiber.dispose();
  }
});

test("requires the same DSH session when applying the prefill plan through the tool", async () => {
  const context = new Context();
  await context.plugin(SystemPrompt);
  await context.plugin(ToolRuntime);
  const source: BossWatchDataSource = {
    async listJobs() {
      return [];
    },
    async listApplicationOverviews() {
      return [];
    },
    async getApplicationOverview() {
      return undefined;
    },
    async getJob() {
      return undefined;
    },
    async listTimeline() {
      return [];
    },
  };
  const formPreview = service();
  const dispose = registerBossWatchTools(
    context,
    source,
    browser(READY_FORM),
    undefined,
    { get: () => LEAD } as unknown as JobLeadStore,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { get: () => RESUME } as unknown as ResumeVersionStore,
    undefined,
    undefined,
    undefined,
    formPreview,
  );
  try {
    const previewResult = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId("application-form-session-preview"),
      name: "boss_watch_application_form_preview",
      arguments: { leadId: LEAD.leadId, gateAId: GATE_A.gateAId },
      agent: { id: "dsh-session-fixture" } as never,
    });
    const previewContent = previewResult.content[0];
    if (previewContent?.type !== "text") throw new Error("expected_text_tool_result");
    const previewToken = (JSON.parse(previewContent.text) as { preview: { previewToken: string } }).preview
      .previewToken;

    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId("application-form-session-mismatch"),
      name: "boss_watch_application_form_fill_apply",
      arguments: { previewToken, confirmed: true },
      agent: { id: "different-dsh-session" } as never,
    });
    const content = result.content[0];
    if (content?.type !== "text") throw new Error("expected_text_tool_result");
    assert.deepEqual(JSON.parse(content.text), {
      status: "conflict",
      message: "application_form_preview_session_mismatch",
    });
  } finally {
    dispose();
    await context.fiber.dispose();
  }
});

test("does not expose unexpected local error details through the DSH tool", async () => {
  const context = new Context();
  await context.plugin(SystemPrompt);
  await context.plugin(ToolRuntime);
  const source: BossWatchDataSource = {
    async listJobs() {
      return [];
    },
    async listApplicationOverviews() {
      return [];
    },
    async getApplicationOverview() {
      return undefined;
    },
    async getJob() {
      return undefined;
    },
    async listTimeline() {
      return [];
    },
  };
  const formPreview = service({
    readText: async () => {
      throw new Error("/private/local/resumes/candidate.pdf");
    },
  });
  const dispose = registerBossWatchTools(
    context,
    source,
    browser(READY_FORM),
    undefined,
    { get: () => LEAD } as unknown as JobLeadStore,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { get: () => RESUME } as unknown as ResumeVersionStore,
    undefined,
    undefined,
    undefined,
    formPreview,
  );
  try {
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId("application-form-preview-redacted-error"),
      name: "boss_watch_application_form_preview",
      arguments: { leadId: LEAD.leadId, gateAId: GATE_A.gateAId },
      agent: { id: "dsh-session-fixture" } as never,
    });
    const content = result.content[0];
    if (content?.type !== "text") throw new Error("expected_text_tool_result");
    const payload = JSON.parse(content.text) as { status: string; message: string };
    assert.deepEqual(payload, {
      status: "source_unavailable",
      message: "application_form_preview_failed",
    });
    assert.equal(content.text.includes("/private/local"), false);
  } finally {
    dispose();
    await context.fiber.dispose();
  }
});
