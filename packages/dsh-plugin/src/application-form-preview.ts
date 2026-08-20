import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type {
  AtsAutofillProfile,
  LocalAtsAutofillProfileService,
} from "./ats-autofill-profile.js";
import type { CandidateProfileStore } from "./candidate-profile.js";
import type {
  BossWatchBrowserController,
  BrowserApplicationFormField,
  BrowserApplicationFormInspection,
} from "./domain.js";
import type { GateAApproval, GateAStore } from "./gate-a.js";
import type { JobLead, JobLeadStore } from "./job-lead.js";
import type { RecruitmentSourceStore } from "./recruitment-source.js";
import type {
  LocalResumeImportService,
  ResumeArtifactContent,
  ResumeTextContent,
  ResumeVersionStore,
} from "./resume-version.js";

export type ApplicationFormSemantic =
  | "resume_file"
  | "full_name"
  | "email"
  | "phone"
  | "location"
  | "school"
  | "major"
  | "education"
  | "graduation_year"
  | "work_experience"
  | "skills"
  | "portfolio_url"
  | "position_keywords"
  | "preferred_city"
  | "arrival_time"
  | "wechat"
  | "internship_duration"
  | "target_role"
  | "id_number"
  | "birth_date"
  | "gender"
  | "marital_status"
  | "political_status"
  | "health"
  | "salary_expectation"
  | "consent"
  | "unknown";

export type ApplicationFormFieldCategory = "resume_available" | "needs_user_input" | "sensitive" | "unknown";

export interface ApplicationFormFieldPreview {
  readonly fieldId: string;
  readonly ordinal: number;
  readonly label: string;
  readonly controlType: BrowserApplicationFormField["controlType"];
  readonly required: boolean;
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly currentState: BrowserApplicationFormField["currentState"];
  readonly semantic: ApplicationFormSemantic;
  readonly category: ApplicationFormFieldCategory;
  readonly source: "resume" | "job_lead" | "candidate_profile" | "none";
  readonly sourceAvailability: "available" | "not_observed" | "not_applicable";
  readonly personalData: boolean;
  readonly metadataTrust: "untrusted_page";
  readonly plannedAction: "fill" | "upload" | "keep_existing" | "manual";
}

export interface ApplicationFormPreview {
  readonly previewId: string;
  readonly previewToken: string;
  readonly strategyVersion: "application-form-prefill-v2";
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly gateA: Pick<GateAApproval, "gateAId" | "matchId" | "applicationId" | "resumeVersionId">;
  readonly lead: Pick<JobLead, "leadId" | "company" | "role" | "contentHash" | "confidence"> & {
    readonly officialApplyUrl: string;
  };
  readonly resume: {
    readonly resumeVersionId: string;
    readonly displayName: string;
    readonly contentHash: string;
    readonly mediaType: string;
  };
  readonly resumeExtraction: {
    readonly status: ResumeTextContent["extractionStatus"];
    readonly characterCount: number;
  };
  readonly profile: {
    readonly strategyVersion: "ats-autofill-profile-v1";
    readonly persistence: "sqlite_by_resume_snapshot" | "transient_compatibility";
    /** The model is not called once per field; the local profile is batched. */
    readonly fillStrategy: "deterministic_dom_batch";
    readonly modelCalls: 0;
    readonly browserCallsAfterApproval: 1;
    readonly availableSemantics: readonly ApplicationFormSemantic[];
  };
  readonly page: Extract<BrowserApplicationFormInspection, { readonly status: "ready" }>["page"];
  readonly fields: readonly ApplicationFormFieldPreview[];
  readonly summary: {
    readonly fieldCount: number;
    readonly resumeAvailableCount: number;
    readonly needsUserInputCount: number;
    readonly sensitiveCount: number;
    readonly unknownCount: number;
    readonly alreadyPresentCount: number;
    readonly fillableCount: number;
    readonly manualCount: number;
    readonly uploadCount: number;
  };
  readonly warnings: readonly string[];
  readonly readOnly: true;
  readonly externalAction: "not_started";
  readonly requiresGateB: true;
  readonly requiresOneShotApproval: true;
}

export type ApplicationFormApplyOutcome =
  | {
      readonly status: "filled";
      readonly leadId: string;
      readonly gateAId: string;
      readonly formHash: string;
      readonly filledFieldIds: readonly string[];
      readonly filledCount: number;
      readonly manualReviewRequired: true;
      readonly submitted: false;
      readonly uploadedResume: boolean;
      readonly nextAction: "review_before_submit" | "next_step_handoff";
    }
  | {
      readonly status: "handoff_required";
      readonly reason: string;
      readonly browserStatus: string;
      readonly targetCount: number;
    }
  | {
      readonly status: "conflict";
      readonly reason: string;
      readonly currentFormHash?: string;
    };

export type ApplicationFormAutofillOutcome =
  | {
      readonly status: "filled";
      readonly company: string;
      readonly role: string;
      readonly leadId: string;
      readonly gateAId: string;
      readonly formHash: string;
      readonly planContentHash: string;
      readonly filledCount: number;
      readonly unresolvedCount: number;
      readonly alreadyPresentCount: number;
      readonly uploadedResume: boolean;
      readonly manualReviewRequired: true;
      readonly submitted: false;
      readonly nextAction: "review_before_submit" | "next_step_handoff";
      readonly authorization: {
        readonly action: "fill_current_page";
        readonly boundToCurrentSession: true;
        readonly expiresAt: string;
      };
    }
  | Extract<ApplicationFormApplyOutcome, { readonly status: "handoff_required" | "conflict" }>;

interface PendingApplicationFormPreview {
  readonly sessionId: string;
  readonly leadId: string;
  readonly gateAId: string;
  readonly leadContentHash: string;
  readonly resumeVersionId: string;
  readonly resumeContentHash: string;
  readonly expectedUrl: string;
  readonly formHash: string;
  readonly planContentHash: string;
  readonly expiresAt: number;
  readonly fields: readonly { readonly fieldId: string; readonly value: string }[];
  readonly resumeUpload?: {
    readonly fieldId: string;
    readonly filePath: string;
    readonly contentHash: string;
  };
}

export type ApplicationFormPreviewOutcome =
  | { readonly status: "ready"; readonly preview: ApplicationFormPreview }
  | {
      readonly status: "handoff_required";
      readonly reason: Exclude<BrowserApplicationFormInspection["status"], "ready"> | string;
      readonly browserStatus: Exclude<BrowserApplicationFormInspection["status"], "ready">;
      readonly targetCount: number;
      readonly detail?: string;
    };

const SENSITIVE_SEMANTICS = new Set<ApplicationFormSemantic>([
  "email",
  "phone",
  "id_number",
  "birth_date",
  "gender",
  "marital_status",
  "political_status",
  "health",
  "salary_expectation",
  "wechat",
]);

const APPROVED_PERSONAL_PREFILL = new Set<ApplicationFormSemantic>([
  "email",
  "phone",
  "wechat",
  "birth_date",
  "gender",
]);

const PROFILE_SEMANTIC_ORDER: readonly ApplicationFormSemantic[] = [
  "full_name",
  "email",
  "phone",
  "location",
  "school",
  "major",
  "education",
  "graduation_year",
  "work_experience",
  "skills",
  "portfolio_url",
  "position_keywords",
  "preferred_city",
  "arrival_time",
  "wechat",
  "internship_duration",
];

export class LocalApplicationFormPreviewService {
  readonly #leads: Pick<JobLeadStore, "get">;
  readonly #resumes: Pick<ResumeVersionStore, "get">;
  readonly #approvals: Pick<GateAStore, "get">;
  readonly #recruitmentSources: Pick<RecruitmentSourceStore, "list">;
  readonly #resumeImport: Pick<LocalResumeImportService, "readText"> &
    Partial<Pick<LocalResumeImportService, "readArtifact">>;
  readonly #atsProfiles: Pick<LocalAtsAutofillProfileService, "getOrCreate"> | undefined;
  readonly #browser: Pick<BossWatchBrowserController, "inspectApplicationForm" | "fillApplicationForm">;
  readonly #candidateProfiles: Pick<CandidateProfileStore, "get"> | undefined;
  readonly #now: () => Date;
  readonly #pending = new Map<string, PendingApplicationFormPreview>();
  readonly #consumed = new Set<string>();
  readonly #consumedPlans = new Map<string, string>();

  constructor(input: {
    leads: Pick<JobLeadStore, "get">;
    resumes: Pick<ResumeVersionStore, "get">;
    approvals: Pick<GateAStore, "get">;
    recruitmentSources: Pick<RecruitmentSourceStore, "list">;
    resumeImport: Pick<LocalResumeImportService, "readText"> &
      Partial<Pick<LocalResumeImportService, "readArtifact">>;
    atsProfiles?: Pick<LocalAtsAutofillProfileService, "getOrCreate">;
    browser: Pick<BossWatchBrowserController, "inspectApplicationForm" | "fillApplicationForm">;
    candidateProfiles?: Pick<CandidateProfileStore, "get">;
    now?: () => Date;
  }) {
    this.#leads = input.leads;
    this.#resumes = input.resumes;
    this.#approvals = input.approvals;
    this.#recruitmentSources = input.recruitmentSources;
    this.#resumeImport = input.resumeImport;
    this.#atsProfiles = input.atsProfiles;
    this.#browser = input.browser;
    this.#candidateProfiles = input.candidateProfiles;
    this.#now = input.now ?? (() => new Date());
  }

  async preview(input: {
    leadId: string;
    gateAId: string;
    sessionId: string;
  }): Promise<ApplicationFormPreviewOutcome> {
    const sessionId = requireText(input.sessionId, "session_id");
    const binding = this.#resolveBinding(input.leadId, input.gateAId);
    const { lead, gateA, resume, officialApplyUrl } = binding;

    const inspected = await this.#browser.inspectApplicationForm(officialApplyUrl);
    if (inspected.status !== "ready") {
      return {
        status: "handoff_required",
        reason: inspected.reason,
        browserStatus: inspected.status,
        targetCount: inspected.targetCount,
        detail: inspected.reason,
      };
    }

    const atsProfile = await this.#resolveAtsProfile(resume);
    const availability = new Set<ApplicationFormSemantic>(atsProfile.availableSemantics);
    const values = atsProfileValues(atsProfile);
    const storedProfile = this.#candidateProfiles?.get();
    values.set("target_role", lead.role);
    values.set("position_keywords", storedProfile?.values.positionKeywords ?? lead.role);
    const preferredCity = lead.city ?? storedProfile?.values.preferredCity;
    if (preferredCity !== undefined) values.set("preferred_city", preferredCity);
    addProfileValue(values, "arrival_time", storedProfile?.values.arrivalTime);
    addProfileValue(values, "wechat", storedProfile?.values.wechat);
    addProfileValue(values, "internship_duration", storedProfile?.values.internshipDuration);
    for (const semantic of values.keys()) availability.add(semantic);
    const fields = inspected.fields.map((field) =>
      classifyField(field, availability, values, {
        preferredCityFromLead: lead.city !== undefined,
        resumeUploadAvailable: this.#resumeImport.readArtifact !== undefined,
      }),
    );
    const now = this.#now();
    const expiresAt = now.getTime() + 15 * 60 * 1000;
    const resumeUploadField = fields.find(
      (field) => field.semantic === "resume_file" && field.plannedAction === "upload",
    );
    const warnings = [
      "page_field_labels_are_untrusted_metadata",
      "existing_field_values_are_redacted",
      "final_submit_remains_manual",
      ...(fields.some((field) => field.category === "sensitive")
        ? ["sensitive_fields_require_manual_review"]
        : []),
      ...(resumeUploadField === undefined ? [] : ["resume_upload_bound_to_gate_a_resume"]),
      ...(atsProfile.extractionStatus === "text_truncated" ? ["resume_text_truncated"] : []),
      ...(fields.some((field) => field.disabled || field.readOnly) ? ["non_editable_fields_present"] : []),
    ];
    const previewId = `application-form-prefill:${createHash("sha256")
      .update(
        `${sessionId}\u0000${gateA.gateAId}\u0000${lead.leadId}\u0000${lead.contentHash}\u0000${resume.resumeVersionId}\u0000${resume.contentHash}\u0000${inspected.page.formHash}`,
      )
      .digest("hex")}`;
    const previewToken = `application-form-prefill:${randomBytes(24).toString("hex")}`;
    const fillFields = fields.flatMap((field) => {
      if (field.plannedAction !== "fill") return [];
      const value = values.get(field.semantic);
      return value === undefined ? [] : [{ fieldId: field.fieldId, value }];
    });
    let resumeUpload: PendingApplicationFormPreview["resumeUpload"];
    if (resumeUploadField !== undefined) {
      if (this.#resumeImport.readArtifact === undefined) throw new Error("application_form_fill_unavailable");
      const artifact: ResumeArtifactContent = await this.#resumeImport.readArtifact(resume.resumeVersionId);
      if (
        artifact.resumeVersion.contentHash !== resume.contentHash ||
        artifact.sourceByteHash !== resume.contentHash
      ) {
        throw new Error("application_form_resume_identity_mismatch");
      }
      resumeUpload = {
        fieldId: resumeUploadField.fieldId,
        filePath: artifact.filePath,
        contentHash: artifact.sourceByteHash,
      };
    }
    const planContentHash = applicationFormPlanHash({
      sessionId,
      gateAId: gateA.gateAId,
      leadId: lead.leadId,
      leadContentHash: lead.contentHash,
      resumeVersionId: resume.resumeVersionId,
      resumeContentHash: resume.contentHash,
      expectedUrl: officialApplyUrl,
      formHash: inspected.page.formHash,
      fields: fillFields,
      ...(resumeUpload === undefined ? {} : { resumeUpload }),
    });
    this.#pruneExpired(now.getTime());
    this.#pending.set(previewToken, {
      sessionId,
      leadId: lead.leadId,
      gateAId: gateA.gateAId,
      leadContentHash: lead.contentHash,
      resumeVersionId: resume.resumeVersionId,
      resumeContentHash: resume.contentHash,
      expectedUrl: officialApplyUrl,
      formHash: inspected.page.formHash,
      planContentHash,
      expiresAt,
      fields: fillFields,
      ...(resumeUpload === undefined ? {} : { resumeUpload }),
    });
    return {
      status: "ready",
      preview: {
        previewId,
        previewToken,
        strategyVersion: "application-form-prefill-v2",
        createdAt: now.toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        gateA: {
          gateAId: gateA.gateAId,
          matchId: gateA.matchId,
          applicationId: gateA.applicationId,
          resumeVersionId: gateA.resumeVersionId,
        },
        lead: {
          leadId: lead.leadId,
          company: lead.company,
          role: lead.role,
          contentHash: lead.contentHash,
          confidence: lead.confidence,
          officialApplyUrl: redactUrl(officialApplyUrl),
        },
        resume: {
          resumeVersionId: resume.resumeVersionId,
          displayName: resume.displayName,
          contentHash: resume.contentHash,
          mediaType: resume.mediaType,
        },
        resumeExtraction: {
          status: atsProfile.extractionStatus,
          characterCount: atsProfile.characterCount,
        },
        profile: {
          strategyVersion: "ats-autofill-profile-v1",
          persistence: this.#atsProfiles === undefined ? "transient_compatibility" : "sqlite_by_resume_snapshot",
          fillStrategy: "deterministic_dom_batch",
          modelCalls: 0,
          browserCallsAfterApproval: 1,
          availableSemantics: PROFILE_SEMANTIC_ORDER.filter((semantic) => availability.has(semantic)),
        },
        page: inspected.page,
        fields,
        summary: {
          fieldCount: fields.length,
          resumeAvailableCount: count(fields, "resume_available"),
          needsUserInputCount: count(fields, "needs_user_input"),
          sensitiveCount: count(fields, "sensitive"),
          unknownCount: count(fields, "unknown"),
          alreadyPresentCount: fields.filter(
            (field) => field.currentState === "present" || field.currentState === "checked",
          ).length,
          fillableCount: fields.filter((field) => field.plannedAction === "fill").length,
          manualCount: fields.filter((field) => field.plannedAction === "manual").length,
          uploadCount: fields.filter((field) => field.plannedAction === "upload").length,
        },
        warnings,
        readOnly: true,
        externalAction: "not_started",
        requiresGateB: true,
        requiresOneShotApproval: true,
      },
    };
  }

  async apply(input: { previewToken: string; sessionId: string }): Promise<ApplicationFormApplyOutcome> {
    const previewToken = requireText(input.previewToken, "preview_token");
    if (this.#consumed.has(previewToken)) throw new Error("application_form_preview_consumed");
    const pending = this.#pending.get(previewToken);
    if (pending === undefined) throw new Error("application_form_preview_not_found");
    const sessionId = requireText(input.sessionId, "session_id");
    if (pending.sessionId !== sessionId) throw new Error("application_form_preview_session_mismatch");
    if (pending.expiresAt <= this.#now().getTime()) {
      this.#pending.delete(previewToken);
      throw new Error("application_form_preview_expired");
    }
    const binding = this.#resolveBinding(pending.leadId, pending.gateAId);
    if (
      binding.lead.contentHash !== pending.leadContentHash ||
      binding.resume.resumeVersionId !== pending.resumeVersionId ||
      binding.resume.contentHash !== pending.resumeContentHash ||
      binding.officialApplyUrl !== pending.expectedUrl
    )
      throw new Error("application_form_preview_binding_changed");
    if (pending.fields.length === 0 && pending.resumeUpload === undefined)
      throw new Error("application_form_no_fillable_fields");
    if (this.#browser.fillApplicationForm === undefined) throw new Error("application_form_fill_unavailable");
    this.#pending.delete(previewToken);
    this.#consumed.add(previewToken);
    this.#consumedPlans.set(previewToken, pending.planContentHash);
    const result = await this.#browser.fillApplicationForm({
      expectedUrl: pending.expectedUrl,
      expectedFormHash: pending.formHash,
      fields: pending.fields,
      ...(pending.resumeUpload === undefined ? {} : { resumeUpload: pending.resumeUpload }),
    });
    if (result.status === "conflict") {
      return {
        status: "conflict",
        reason: result.reason,
        ...(result.currentFormHash === undefined ? {} : { currentFormHash: result.currentFormHash }),
      };
    }
    if (result.status !== "filled") {
      return {
        status: "handoff_required",
        reason: result.reason,
        browserStatus: result.status,
        targetCount: result.targetCount,
      };
    }
    if (
      result.formHash !== pending.formHash ||
      result.filledCount !== pending.fields.length ||
      !sameFieldIds(
        result.filledFieldIds,
        pending.fields.map((field) => field.fieldId),
      )
    )
      return { status: "conflict", reason: "fill_result_mismatch" };
    return {
      status: "filled",
      leadId: pending.leadId,
      gateAId: pending.gateAId,
      formHash: result.formHash,
      filledFieldIds: result.filledFieldIds,
      filledCount: result.filledCount,
      manualReviewRequired: true,
      submitted: false,
      uploadedResume: result.uploadedResume ?? false,
      nextAction: result.nextAction ?? "review_before_submit",
    };
  }

  async autofill(input: {
    leadId: string;
    gateAId: string;
    sessionId: string;
    authorization: "fill_current_page";
  }): Promise<ApplicationFormAutofillOutcome> {
    if (input.authorization !== "fill_current_page") {
      throw new Error("application_form_autofill_authorization_required");
    }
    const preview = await this.preview(input);
    if (preview.status !== "ready") return preview;
    const result = await this.apply({
      previewToken: preview.preview.previewToken,
      sessionId: input.sessionId,
    });
    if (result.status !== "filled") return result;
    return {
      status: "filled",
      company: preview.preview.lead.company,
      role: preview.preview.lead.role,
      leadId: result.leadId,
      gateAId: result.gateAId,
      formHash: result.formHash,
      planContentHash: this.#consumedPlanHash(preview.preview.previewToken),
      filledCount: result.filledCount,
      unresolvedCount: preview.preview.summary.manualCount,
      alreadyPresentCount: preview.preview.summary.alreadyPresentCount,
      uploadedResume: result.uploadedResume,
      manualReviewRequired: true,
      submitted: false,
      nextAction: result.nextAction,
      authorization: {
        action: "fill_current_page",
        boundToCurrentSession: true,
        expiresAt: preview.preview.expiresAt,
      },
    };
  }

  #resolveBinding(
    leadIdInput: string,
    gateAIdInput: string,
  ): {
    lead: JobLead;
    gateA: GateAApproval;
    resume: NonNullable<ReturnType<ResumeVersionStore["get"]>>;
    officialApplyUrl: string;
  } {
    const lead = this.#leads.get(requireText(leadIdInput, "lead_id"));
    if (lead === undefined) throw new Error("application_form_lead_not_found");
    if (lead.confidence !== "human_confirmed" && lead.confidence !== "jd_verified") {
      throw new Error("application_form_lead_not_verified");
    }
    if (lead.officialApplyUrl === undefined) throw new Error("application_form_official_url_missing");
    const gateA = this.#approvals.get(requireText(gateAIdInput, "gate_a_id"));
    if (gateA === undefined) throw new Error("application_form_gate_a_not_found");
    const exactBinding = this.#recruitmentSources
      .list({ limit: 100 })
      .some(
        (source) =>
          source.status === "jd_ready" &&
          source.boundLeadId === lead.leadId &&
          source.boundApplicationId === gateA.applicationId &&
          source.jdContentHash === gateA.jdContentHash,
      );
    if (!exactBinding) throw new Error("application_form_gate_a_binding_missing");
    const resume = this.#resumes.get(gateA.resumeVersionId);
    if (resume === undefined) throw new Error("application_form_resume_not_found");
    if (resume.contentHash !== gateA.resumeContentHash)
      throw new Error("application_form_resume_snapshot_stale");
    return { lead, gateA, resume, officialApplyUrl: normalizeOfficialUrl(lead.officialApplyUrl) };
  }

  async #resolveAtsProfile(
    resume: NonNullable<ReturnType<ResumeVersionStore["get"]>>,
  ): Promise<AtsAutofillProfile> {
    if (this.#atsProfiles !== undefined) return this.#atsProfiles.getOrCreate(resume);
    const extracted = await this.#resumeImport.readText(resume.resumeVersionId);
    if (
      extracted.resumeVersion.resumeVersionId !== resume.resumeVersionId ||
      extracted.resumeVersion.contentHash !== resume.contentHash ||
      extracted.sourceByteHash !== resume.contentHash
    )
      throw new Error("application_form_resume_identity_mismatch");
    return transientAtsProfile(resume, extracted);
  }

  #consumedPlanHash(previewToken: string): string {
    const hash = this.#consumedPlans.get(previewToken);
    if (hash === undefined) throw new Error("application_form_plan_hash_missing");
    return hash;
  }

  #pruneExpired(now: number): void {
    for (const [token, preview] of this.#pending) {
      if (preview.expiresAt <= now) this.#pending.delete(token);
    }
  }
}

function classifyField(
  field: BrowserApplicationFormField,
  availability: ReadonlySet<ApplicationFormSemantic>,
  values: ReadonlyMap<ApplicationFormSemantic, string>,
  sources: { readonly preferredCityFromLead: boolean; readonly resumeUploadAvailable: boolean },
): ApplicationFormFieldPreview {
  const semantic = detectSemantic(field);
  const fromLead = semantic === "target_role";
  const observed = fromLead || availability.has(semantic);
  const sensitive = SENSITIVE_SEMANTICS.has(semantic);
  const plannedValue = values.get(semantic);
  const category: ApplicationFormFieldCategory = sensitive
    ? "sensitive"
    : semantic === "unknown"
      ? "unknown"
      : observed
        ? "resume_available"
        : "needs_user_input";
  const alreadyPresent = field.currentState === "present" || field.currentState === "checked";
  const plannedAction = alreadyPresent
    ? "keep_existing"
    : semantic === "resume_file" &&
        sources.resumeUploadAvailable &&
        !field.disabled &&
        !field.readOnly &&
        field.controlType === "file"
      ? "upload"
      : !field.disabled &&
          !field.readOnly &&
          plannedValue !== undefined &&
          isFillableControl(field.controlType) &&
          canFillControlValue(field, plannedValue) &&
          semantic !== "consent" &&
          (!sensitive || APPROVED_PERSONAL_PREFILL.has(semantic))
        ? "fill"
        : "manual";
  return {
    fieldId: field.fieldId,
    ordinal: field.ordinal,
    label: field.label.length === 0 ? `unnamed_field_${field.ordinal + 1}` : field.label,
    controlType: field.controlType,
    required: field.required,
    disabled: field.disabled,
    readOnly: field.readOnly,
    currentState: field.currentState,
    semantic,
    category,
    source:
      fromLead ||
      semantic === "position_keywords" ||
      (semantic === "preferred_city" && sources.preferredCityFromLead)
        ? "job_lead"
        : new Set<ApplicationFormSemantic>([
              "preferred_city",
              "arrival_time",
              "wechat",
              "internship_duration",
            ]).has(semantic) && observed
          ? "candidate_profile"
          : observed
            ? "resume"
            : "none",
    sourceAvailability: observed
      ? "available"
      : semantic === "unknown" || semantic === "consent"
        ? "not_applicable"
        : "not_observed",
    personalData: isPersonalData(semantic),
    metadataTrust: "untrusted_page",
    plannedAction,
  };
}

function detectSemantic(field: BrowserApplicationFormField): ApplicationFormSemantic {
  const metadata = normalize(`${field.label} ${field.name ?? ""} ${field.autocomplete ?? ""}`);
  const autocomplete = normalize(field.autocomplete ?? "");
  if (
    field.controlType === "file" ||
    contains(metadata, ["上传简历", "简历附件", "resume", "curriculum vitae", " cv "])
  )
    return "resume_file";
  if (contains(metadata, ["身份证", "证件号码", "证件号", "identity card", "national id", "id number"]))
    return "id_number";
  if (
    field.controlType === "email" ||
    autocomplete === "email" ||
    contains(metadata, ["邮箱", "电子邮件", "e-mail", "email"])
  )
    return "email";
  if (
    field.controlType === "tel" ||
    autocomplete === "tel" ||
    contains(metadata, ["手机号", "手机号码", "联系电话", "电话号码", "phone", "mobile", "telephone"])
  )
    return "phone";
  if (
    autocomplete.startsWith("bday") ||
    contains(metadata, ["出生日期", "生日", "date of birth", "birth date", "birthday"])
  )
    return "birth_date";
  if (contains(metadata, ["性别", "gender", "sex"])) return "gender";
  if (contains(metadata, ["婚姻", "marital"])) return "marital_status";
  if (contains(metadata, ["政治面貌", "political status"])) return "political_status";
  if (contains(metadata, ["健康状况", "health condition"])) return "health";
  if (contains(metadata, ["期望薪资", "当前薪资", "salary", "compensation"])) return "salary_expectation";
  if (
    (field.controlType === "checkbox" || field.controlType === "radio") &&
    contains(metadata, ["同意", "隐私", "条款", "声明", "授权", "agree", "consent", "privacy", "terms"])
  )
    return "consent";
  if (
    autocomplete === "name" ||
    contains(metadata, ["姓名", "真实姓名", "full name", "candidate name", "your name"])
  )
    return "full_name";
  if (
    contains(metadata, ["申请岗位", "应聘岗位", "职位名称", "position applied", "target role", "job title"])
  )
    return "target_role";
  if (
    contains(metadata, [
      "职位关键字",
      "岗位关键字",
      "职位关键词",
      "岗位关键词",
      "position keyword",
      "job keyword",
    ])
  )
    return "position_keywords";
  if (contains(metadata, ["意向城市", "期望城市", "求职城市", "工作城市", "desired city", "preferred city"]))
    return "preferred_city";
  if (contains(metadata, ["到岗时间", "可到岗", "入职时间", "available date", "start date"]))
    return "arrival_time";
  if (contains(metadata, ["微信号", "微信", "wechat", "weixin"])) return "wechat";
  if (contains(metadata, ["可实习时长", "实习时长", "实习周期", "internship duration"]))
    return "internship_duration";
  if (
    autocomplete.startsWith("address") ||
    contains(metadata, ["所在城市", "现居地", "居住地", "location", "current city", "city"])
  )
    return "location";
  if (contains(metadata, ["毕业院校", "学校", "school", "university", "college"])) return "school";
  if (contains(metadata, ["专业名称", "所学专业", "专业", "major", "discipline"])) return "major";
  if (contains(metadata, ["最高学历", "学历", "education", "degree"])) return "education";
  if (contains(metadata, ["毕业时间", "毕业年份", "graduation year", "graduate year"]))
    return "graduation_year";
  if (
    contains(metadata, [
      "工作经历",
      "实习经历",
      "项目经历",
      "work experience",
      "employment history",
      "experience",
    ])
  )
    return "work_experience";
  if (contains(metadata, ["技能", "技术栈", "skill", "tech stack"])) return "skills";
  if (
    field.controlType === "url" ||
    contains(metadata, ["作品集", "个人主页", "github", "portfolio", "website", "homepage"])
  )
    return "portfolio_url";
  return "unknown";
}

function resumeAvailability(text: string): ReadonlySet<ApplicationFormSemantic> {
  const available = new Set<ApplicationFormSemantic>(["resume_file"]);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const firstLine = lines[0] ?? "";
  if (
    /(?:^|\n)\s*(?:姓名|name)\s*[:：]\s*[\p{L} .·-]{2,40}(?:\n|$)/iu.test(text) ||
    (/^[\p{Script=Han}A-Za-z .·-]{2,20}$/u.test(firstLine) &&
      !/(简历|求职|开发|工程师|大学|学院|resume|curriculum)/iu.test(firstLine))
  )
    available.add("full_name");
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(text)) available.add("email");
  if (/(?:\+?86[- ]?)?1[3-9]\d{9}/u.test(text)) available.add("phone");
  if (
    /(北京|上海|广州|深圳|杭州|南京|苏州|成都|武汉|西安|重庆|天津|宁波|厦门|福州|合肥|郑州|长沙|青岛|济南|大连|无锡|东莞|珠海)/u.test(
      text,
    )
  )
    available.add("location");
  if (/(大学|学院|university|college)/iu.test(text)) available.add("school");
  if (
    /(?:专业|major)\s*[:：]?\s*[\p{L}\p{N}()+.# -]{2,60}|计算机(?:科学与技术|技术|软件)?|软件工程|人工智能/iu.test(
      text,
    )
  )
    available.add("major");
  if (/(博士|硕士|本科|大专|ph\.?d|master|bachelor|associate degree)/iu.test(text))
    available.add("education");
  if (/20\d{2}\s*(?:届|年毕业|毕业)/u.test(text)) available.add("graduation_year");
  if (/(工作经历|实习经历|项目经历|work experience|employment|internship|project experience)/iu.test(text))
    available.add("work_experience");
  if (/(专业技能|技能|技术栈|skills?|tech stack|java|python|typescript|spring|redis|mysql)/iu.test(text))
    available.add("skills");
  if (/(https?:\/\/|github\.com|gitlab\.com|作品集|portfolio)/iu.test(text)) available.add("portfolio_url");
  if (/\b\d{17}[\dX]\b/iu.test(text)) available.add("id_number");
  if (/(?:出生日期|生日)\s*[:：]?\s*(?:19|20)\d{2}/u.test(text)) available.add("birth_date");
  if (/(?:性别)\s*[:：]?\s*(?:男|女)/u.test(text)) available.add("gender");
  if (/(?:婚姻状况)\s*[:：]?\s*(?:已婚|未婚)/u.test(text)) available.add("marital_status");
  if (/(?:政治面貌)\s*[:：]?\s*\S+/u.test(text)) available.add("political_status");
  return available;
}

function candidateProfileValues(text: string): Map<ApplicationFormSemantic, string> {
  const values = new Map<ApplicationFormSemantic, string>();
  addProfileValue(
    values,
    "full_name",
    matchValue(text, [/(?:^|\n)\s*(?:姓名|name)\s*[:：]\s*([^\n]{2,40})(?:\n|$)/iu]),
  );
  addProfileValue(values, "email", matchValue(text, [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu], 0));
  addProfileValue(values, "phone", matchValue(text, [/(?:\+?86[- ]?)?1[3-9]\d{9}/u], 0));
  addProfileValue(
    values,
    "location",
    matchValue(text, [/(?:现居地|所在地|所在城市|居住地|location|city)\s*[:：]\s*([^\n]{2,40})(?:\n|$)/iu]),
  );
  addProfileValue(
    values,
    "school",
    matchValue(text, [
      /(?:毕业院校|学校|school|university)\s*[:：]\s*([^\n]{2,80})(?:\n|$)/iu,
      /([\p{Script=Han}A-Za-z· ]{2,40}(?:大学|学院))/u,
    ]),
  );
  addProfileValue(
    values,
    "major",
    matchValue(text, [
      /(?:专业名称|所学专业|专业|major)\s*[:：]\s*([^\n]{2,60})(?:\n|$)/iu,
      /(计算机科学与技术|计算机技术|软件工程|人工智能|数据科学与大数据技术|信息安全)/u,
    ]),
  );
  addProfileValue(
    values,
    "education",
    matchValue(text, [/(博士|硕士|本科|大专|ph\.?d|master|bachelor|associate degree)/iu]),
  );
  addProfileValue(values, "graduation_year", matchValue(text, [/(20\d{2})\s*(?:届|年毕业|毕业)/u]));
  addProfileValue(
    values,
    "birth_date",
    normalizeProfileDate(
      matchValue(text, [
        /(?:出生日期|生日|date of birth|birth date)\s*[:：]\s*((?:19|20)\d{2}[./-]\d{1,2}[./-]\d{1,2})/iu,
      ]),
    ),
  );
  addProfileValue(values, "gender", matchValue(text, [/(?:性别|gender)\s*[:：]\s*(男|女|male|female)/iu]));
  addProfileValue(
    values,
    "portfolio_url",
    matchValue(text, [/(https?:\/\/(?:www\.)?(?:github|gitlab)\.com\/[^\s)]+)/iu], 0),
  );
  return values;
}

function transientAtsProfile(
  resume: NonNullable<ReturnType<ResumeVersionStore["get"]>>,
  extracted: ResumeTextContent,
): AtsAutofillProfile {
  const values = candidateProfileValues(extracted.text);
  const availableSemantics = [...resumeAvailability(extracted.text)].filter(
    (semantic): semantic is AtsAutofillProfile["availableSemantics"][number] =>
      new Set<string>([
        "resume_file",
        "full_name",
        "email",
        "phone",
        "location",
        "school",
        "major",
        "education",
        "graduation_year",
        "birth_date",
        "gender",
        "work_experience",
        "skills",
        "portfolio_url",
      ]).has(semantic),
  );
  const profileValues = {
    ...(values.get("full_name") === undefined ? {} : { fullName: values.get("full_name") }),
    ...(values.get("email") === undefined ? {} : { email: values.get("email") }),
    ...(values.get("phone") === undefined ? {} : { phone: values.get("phone") }),
    ...(values.get("location") === undefined ? {} : { currentCity: values.get("location") }),
    ...(values.get("school") === undefined ? {} : { school: values.get("school") }),
    ...(values.get("major") === undefined ? {} : { major: values.get("major") }),
    ...(values.get("education") === undefined ? {} : { education: values.get("education") }),
    ...(values.get("graduation_year") === undefined
      ? {}
      : { graduationYear: values.get("graduation_year") }),
    ...(values.get("birth_date") === undefined ? {} : { birthDate: values.get("birth_date") }),
    ...(values.get("gender") === undefined ? {} : { gender: values.get("gender") }),
    ...(values.get("portfolio_url") === undefined
      ? {}
      : { portfolioUrl: values.get("portfolio_url") }),
  };
  const canonical = JSON.stringify({
    resumeVersionId: resume.resumeVersionId,
    resumeContentHash: resume.contentHash,
    availableSemantics,
    profileValues,
  });
  return {
    profileId: `ats-autofill-profile:${resume.contentHash}`,
    strategyVersion: "ats-autofill-profile-v1",
    resumeVersionId: resume.resumeVersionId,
    resumeContentHash: resume.contentHash,
    extractionStatus: extracted.extractionStatus,
    characterCount: extracted.characterCount,
    availableSemantics,
    values: profileValues,
    updatedAt: resume.createdAt,
    contentHash: createHash("sha256").update(canonical).digest("hex"),
  };
}

function atsProfileValues(profile: AtsAutofillProfile): Map<ApplicationFormSemantic, string> {
  const values = new Map<ApplicationFormSemantic, string>();
  addProfileValue(values, "full_name", profile.values.fullName);
  addProfileValue(values, "email", profile.values.email);
  addProfileValue(values, "phone", profile.values.phone);
  addProfileValue(values, "location", profile.values.currentCity);
  addProfileValue(values, "school", profile.values.school);
  addProfileValue(values, "major", profile.values.major);
  addProfileValue(values, "education", profile.values.education);
  addProfileValue(values, "graduation_year", profile.values.graduationYear);
  addProfileValue(values, "birth_date", profile.values.birthDate);
  addProfileValue(values, "gender", profile.values.gender);
  addProfileValue(values, "portfolio_url", profile.values.portfolioUrl);
  return values;
}

function applicationFormPlanHash(input: {
  readonly sessionId: string;
  readonly gateAId: string;
  readonly leadId: string;
  readonly leadContentHash: string;
  readonly resumeVersionId: string;
  readonly resumeContentHash: string;
  readonly expectedUrl: string;
  readonly formHash: string;
  readonly fields: readonly { readonly fieldId: string; readonly value: string }[];
  readonly resumeUpload?: {
    readonly fieldId: string;
    readonly contentHash: string;
  };
}): string {
  const canonical = JSON.stringify({
    sessionIdHash: createHash("sha256").update(input.sessionId).digest("hex"),
    gateAId: input.gateAId,
    leadId: input.leadId,
    leadContentHash: input.leadContentHash,
    resumeVersionId: input.resumeVersionId,
    resumeContentHash: input.resumeContentHash,
    expectedUrlHash: createHash("sha256").update(input.expectedUrl).digest("hex"),
    formHash: input.formHash,
    fields: input.fields.map((field) => ({
      fieldId: field.fieldId,
      valueHash: createHash("sha256").update(field.value).digest("hex"),
    })),
    ...(input.resumeUpload === undefined
      ? {}
      : {
          resumeUpload: {
            fieldId: input.resumeUpload.fieldId,
            contentHash: input.resumeUpload.contentHash,
          },
        }),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function matchValue(text: string, patterns: readonly RegExp[], group = 1): string | undefined {
  for (const pattern of patterns) {
    const value = pattern.exec(text)?.[group];
    if (value !== undefined) return value.trim();
  }
  return undefined;
}

function normalizeProfileDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const [year, month, day] = value.split(/[./-]/u);
  if (year === undefined || month === undefined || day === undefined) return undefined;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function addProfileValue(
  values: Map<ApplicationFormSemantic, string>,
  semantic: ApplicationFormSemantic,
  value: string | undefined,
): void {
  if (value === undefined) return;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
  if (normalized.length > 0) values.set(semantic, normalized);
}

function isFillableControl(controlType: BrowserApplicationFormField["controlType"]): boolean {
  return new Set<BrowserApplicationFormField["controlType"]>([
    "text",
    "email",
    "tel",
    "url",
    "number",
    "date",
    "month",
    "textarea",
    "select",
    "combobox",
  ]).has(controlType);
}

function canFillControlValue(field: BrowserApplicationFormField, value: string): boolean {
  if (field.controlType === "date") return /^\d{4}-\d{2}-\d{2}$/u.test(value);
  if (field.controlType === "month") return /^\d{4}-\d{2}$/u.test(value);
  if (field.controlType === "number") return /^-?\d+(?:\.\d+)?$/u.test(value);
  if (field.controlType !== "select" && field.controlType !== "combobox") return true;
  if (field.options === undefined || field.options.length === 0) return field.controlType === "combobox";
  const wanted = normalizeOptionValue(value);
  return field.options.some((option) =>
    optionValueMatches(wanted, normalizeOptionValue(option.label), normalizeOptionValue(option.value ?? "")),
  );
}

function optionValueMatches(wanted: string, label: string, value: string): boolean {
  if (label === wanted || value === wanted) return true;
  if (wanted === "硕士" && label === "硕士研究生") return true;
  if (wanted === "本科" && label === "大学本科") return true;
  const withoutCitySuffix = (text: string): string => text.replace(/市$/u, "");
  return wanted.length >= 2 && withoutCitySuffix(label) === withoutCitySuffix(wanted);
}

function normalizeOptionValue(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("zh-CN");
}

function sameFieldIds(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((fieldId, index) => fieldId === expected[index]);
}

function normalize(value: string): string {
  return ` ${value
    .toLocaleLowerCase("zh-CN")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()} `;
}

function contains(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term));
}

function isPersonalData(semantic: ApplicationFormSemantic): boolean {
  return !new Set<ApplicationFormSemantic>([
    "resume_file",
    "skills",
    "target_role",
    "consent",
    "unknown",
  ]).has(semantic);
}

function count(
  fields: readonly ApplicationFormFieldPreview[],
  category: ApplicationFormFieldCategory,
): number {
  return fields.filter((field) => field.category === category).length;
}

function normalizeOfficialUrl(value: string): string {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      (url.port !== "" && url.port !== "443") ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      isIP(hostname) !== 0
    )
      throw new Error();
    url.hash = "";
    return url.toString();
  } catch {
    throw new Error("application_form_official_url_invalid");
  }
}

function redactUrl(value: string): string {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`invalid_${name}`);
  return normalized;
}
