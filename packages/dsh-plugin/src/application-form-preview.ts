import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import type {
  BrowserApplicationFormField,
  BrowserApplicationFormInspection,
  BossWatchBrowserController,
} from './domain.js'
import type { JobLead, JobLeadStore } from './job-lead.js'
import type {
  LocalResumeImportService,
  ResumeTextContent,
  ResumeVersionStore,
} from './resume-version.js'

export type ApplicationFormSemantic =
  | 'resume_file'
  | 'full_name'
  | 'email'
  | 'phone'
  | 'location'
  | 'school'
  | 'major'
  | 'education'
  | 'graduation_year'
  | 'work_experience'
  | 'skills'
  | 'portfolio_url'
  | 'target_role'
  | 'id_number'
  | 'birth_date'
  | 'gender'
  | 'marital_status'
  | 'political_status'
  | 'health'
  | 'salary_expectation'
  | 'consent'
  | 'unknown'

export type ApplicationFormFieldCategory =
  | 'resume_available'
  | 'needs_user_input'
  | 'sensitive'
  | 'unknown'

export interface ApplicationFormFieldPreview {
  readonly fieldId: string
  readonly ordinal: number
  readonly label: string
  readonly controlType: BrowserApplicationFormField['controlType']
  readonly required: boolean
  readonly disabled: boolean
  readonly readOnly: boolean
  readonly currentState: BrowserApplicationFormField['currentState']
  readonly semantic: ApplicationFormSemantic
  readonly category: ApplicationFormFieldCategory
  readonly source: 'resume' | 'job_lead' | 'none'
  readonly sourceAvailability: 'available' | 'not_observed' | 'not_applicable'
  readonly personalData: boolean
  readonly metadataTrust: 'untrusted_page'
}

export interface ApplicationFormPreview {
  readonly previewId: string
  readonly strategyVersion: 'application-form-preview-v1'
  readonly createdAt: string
  readonly expiresAt: string
  readonly lead: Pick<JobLead, 'leadId' | 'company' | 'role' | 'contentHash' | 'confidence'> & {
    readonly officialApplyUrl: string
  }
  readonly resume: {
    readonly resumeVersionId: string
    readonly displayName: string
    readonly contentHash: string
    readonly mediaType: string
  }
  readonly resumeExtraction: {
    readonly status: ResumeTextContent['extractionStatus']
    readonly characterCount: number
  }
  readonly page: Extract<BrowserApplicationFormInspection, { readonly status: 'ready' }>['page']
  readonly fields: readonly ApplicationFormFieldPreview[]
  readonly summary: {
    readonly fieldCount: number
    readonly resumeAvailableCount: number
    readonly needsUserInputCount: number
    readonly sensitiveCount: number
    readonly unknownCount: number
    readonly alreadyPresentCount: number
  }
  readonly warnings: readonly string[]
  readonly readOnly: true
  readonly externalAction: 'not_started'
  readonly requiresGateB: true
}

export type ApplicationFormPreviewOutcome =
  | { readonly status: 'ready'; readonly preview: ApplicationFormPreview }
  | {
      readonly status: 'handoff_required'
      readonly reason: Exclude<BrowserApplicationFormInspection['status'], 'ready'> | string
      readonly browserStatus: Exclude<BrowserApplicationFormInspection['status'], 'ready'>
      readonly targetCount: number
      readonly detail?: string
    }

const SENSITIVE_SEMANTICS = new Set<ApplicationFormSemantic>([
  'email',
  'phone',
  'id_number',
  'birth_date',
  'gender',
  'marital_status',
  'political_status',
  'health',
  'salary_expectation',
])

export class LocalApplicationFormPreviewService {
  readonly #leads: Pick<JobLeadStore, 'get'>
  readonly #resumes: Pick<ResumeVersionStore, 'get'>
  readonly #resumeImport: Pick<LocalResumeImportService, 'readText'>
  readonly #browser: Pick<BossWatchBrowserController, 'inspectApplicationForm'>
  readonly #now: () => Date

  constructor(input: {
    leads: Pick<JobLeadStore, 'get'>
    resumes: Pick<ResumeVersionStore, 'get'>
    resumeImport: Pick<LocalResumeImportService, 'readText'>
    browser: Pick<BossWatchBrowserController, 'inspectApplicationForm'>
    now?: () => Date
  }) {
    this.#leads = input.leads
    this.#resumes = input.resumes
    this.#resumeImport = input.resumeImport
    this.#browser = input.browser
    this.#now = input.now ?? (() => new Date())
  }

  async preview(input: { leadId: string; resumeVersionId: string }): Promise<ApplicationFormPreviewOutcome> {
    const lead = this.#leads.get(requireText(input.leadId, 'lead_id'))
    if (lead === undefined) throw new Error('application_form_lead_not_found')
    if (lead.confidence !== 'human_confirmed' && lead.confidence !== 'jd_verified') {
      throw new Error('application_form_lead_not_verified')
    }
    if (lead.officialApplyUrl === undefined) throw new Error('application_form_official_url_missing')
    const officialApplyUrl = normalizeOfficialUrl(lead.officialApplyUrl)
    const resume = this.#resumes.get(input.resumeVersionId)
    if (resume === undefined) throw new Error('application_form_resume_not_found')

    const inspected = await this.#browser.inspectApplicationForm(officialApplyUrl)
    if (inspected.status !== 'ready') {
      return {
        status: 'handoff_required',
        reason: inspected.reason,
        browserStatus: inspected.status,
        targetCount: inspected.targetCount,
        detail: inspected.reason,
      }
    }

    const extracted = await this.#resumeImport.readText(resume.resumeVersionId)
    if (
      extracted.resumeVersion.resumeVersionId !== resume.resumeVersionId
      || extracted.resumeVersion.contentHash !== resume.contentHash
      || extracted.sourceByteHash !== resume.contentHash
    ) throw new Error('application_form_resume_identity_mismatch')

    const availability = resumeAvailability(extracted.text)
    const fields = inspected.fields.map((field) => classifyField(field, availability))
    const now = this.#now()
    const warnings = [
      'page_field_labels_are_untrusted_metadata',
      'existing_field_values_are_redacted',
      ...extracted.extractionStatus === 'text_truncated' ? ['resume_text_truncated'] : [],
      ...fields.some((field) => field.disabled || field.readOnly) ? ['non_editable_fields_present'] : [],
    ]
    const previewId = `application-form-preview:${createHash('sha256')
      .update(`${lead.leadId}\u0000${lead.contentHash}\u0000${resume.resumeVersionId}\u0000${resume.contentHash}\u0000${inspected.page.formHash}`)
      .digest('hex')}`
    return {
      status: 'ready',
      preview: {
        previewId,
        strategyVersion: 'application-form-preview-v1',
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
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
          status: extracted.extractionStatus,
          characterCount: extracted.characterCount,
        },
        page: inspected.page,
        fields,
        summary: {
          fieldCount: fields.length,
          resumeAvailableCount: count(fields, 'resume_available'),
          needsUserInputCount: count(fields, 'needs_user_input'),
          sensitiveCount: count(fields, 'sensitive'),
          unknownCount: count(fields, 'unknown'),
          alreadyPresentCount: fields.filter((field) => field.currentState === 'present' || field.currentState === 'checked').length,
        },
        warnings,
        readOnly: true,
        externalAction: 'not_started',
        requiresGateB: true,
      },
    }
  }
}

function classifyField(
  field: BrowserApplicationFormField,
  availability: ReadonlySet<ApplicationFormSemantic>,
): ApplicationFormFieldPreview {
  const semantic = detectSemantic(field)
  const fromLead = semantic === 'target_role'
  const observed = fromLead || availability.has(semantic)
  const sensitive = SENSITIVE_SEMANTICS.has(semantic)
  const category: ApplicationFormFieldCategory = sensitive
    ? 'sensitive'
    : semantic === 'unknown'
      ? 'unknown'
      : observed
        ? 'resume_available'
        : 'needs_user_input'
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
    source: fromLead ? 'job_lead' : observed ? 'resume' : 'none',
    sourceAvailability: observed ? 'available' : semantic === 'unknown' || semantic === 'consent' ? 'not_applicable' : 'not_observed',
    personalData: isPersonalData(semantic),
    metadataTrust: 'untrusted_page',
  }
}

function detectSemantic(field: BrowserApplicationFormField): ApplicationFormSemantic {
  const metadata = normalize(`${field.label} ${field.name ?? ''} ${field.autocomplete ?? ''}`)
  const autocomplete = normalize(field.autocomplete ?? '')
  if (field.controlType === 'file' || contains(metadata, ['上传简历', '简历附件', 'resume', 'curriculum vitae', ' cv '])) return 'resume_file'
  if (contains(metadata, ['身份证', '证件号码', '证件号', 'identity card', 'national id', 'id number'])) return 'id_number'
  if (field.controlType === 'email' || autocomplete === 'email' || contains(metadata, ['邮箱', '电子邮件', 'e-mail', 'email'])) return 'email'
  if (field.controlType === 'tel' || autocomplete === 'tel' || contains(metadata, ['手机号', '手机号码', '联系电话', '电话号码', 'phone', 'mobile', 'telephone'])) return 'phone'
  if (field.controlType === 'date' || autocomplete.startsWith('bday') || contains(metadata, ['出生日期', '生日', 'date of birth', 'birth date', 'birthday'])) return 'birth_date'
  if (contains(metadata, ['性别', 'gender', 'sex'])) return 'gender'
  if (contains(metadata, ['婚姻', 'marital'])) return 'marital_status'
  if (contains(metadata, ['政治面貌', 'political status'])) return 'political_status'
  if (contains(metadata, ['健康状况', 'health condition'])) return 'health'
  if (contains(metadata, ['期望薪资', '当前薪资', 'salary', 'compensation'])) return 'salary_expectation'
  if ((field.controlType === 'checkbox' || field.controlType === 'radio') && contains(metadata, ['同意', '隐私', '条款', '声明', '授权', 'agree', 'consent', 'privacy', 'terms'])) return 'consent'
  if (autocomplete === 'name' || contains(metadata, ['姓名', '真实姓名', 'full name', 'candidate name', 'your name'])) return 'full_name'
  if (contains(metadata, ['申请岗位', '应聘岗位', '职位名称', 'position applied', 'target role', 'job title'])) return 'target_role'
  if (autocomplete.startsWith('address') || contains(metadata, ['所在城市', '现居地', '居住地', 'location', 'current city', 'city'])) return 'location'
  if (contains(metadata, ['毕业院校', '学校', 'school', 'university', 'college'])) return 'school'
  if (contains(metadata, ['专业名称', '所学专业', '专业', 'major', 'discipline'])) return 'major'
  if (contains(metadata, ['最高学历', '学历', 'education', 'degree'])) return 'education'
  if (contains(metadata, ['毕业时间', '毕业年份', 'graduation year', 'graduate year'])) return 'graduation_year'
  if (contains(metadata, ['工作经历', '实习经历', '项目经历', 'work experience', 'employment history', 'experience'])) return 'work_experience'
  if (contains(metadata, ['技能', '技术栈', 'skill', 'tech stack'])) return 'skills'
  if (field.controlType === 'url' || contains(metadata, ['作品集', '个人主页', 'github', 'portfolio', 'website', 'homepage'])) return 'portfolio_url'
  return 'unknown'
}

function resumeAvailability(text: string): ReadonlySet<ApplicationFormSemantic> {
  const available = new Set<ApplicationFormSemantic>(['resume_file'])
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const firstLine = lines[0] ?? ''
  if (
    /(?:^|\n)\s*(?:姓名|name)\s*[:：]\s*[\p{L} .·-]{2,40}(?:\n|$)/iu.test(text)
    || (/^[\p{Script=Han}A-Za-z .·-]{2,20}$/u.test(firstLine) && !/(简历|求职|开发|工程师|大学|学院|resume|curriculum)/iu.test(firstLine))
  ) available.add('full_name')
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(text)) available.add('email')
  if (/(?:\+?86[- ]?)?1[3-9]\d{9}/u.test(text)) available.add('phone')
  if (/(北京|上海|广州|深圳|杭州|南京|苏州|成都|武汉|西安|重庆|天津|宁波|厦门|福州|合肥|郑州|长沙|青岛|济南|大连|无锡|东莞|珠海)/u.test(text)) available.add('location')
  if (/(大学|学院|university|college)/iu.test(text)) available.add('school')
  if (/(?:专业|major)\s*[:：]?\s*[\p{L}\p{N}()+.# -]{2,60}|计算机(?:科学与技术|技术|软件)?|软件工程|人工智能/iu.test(text)) available.add('major')
  if (/(博士|硕士|本科|大专|ph\.?d|master|bachelor|associate degree)/iu.test(text)) available.add('education')
  if (/20\d{2}\s*(?:届|年毕业|毕业)/u.test(text)) available.add('graduation_year')
  if (/(工作经历|实习经历|项目经历|work experience|employment|internship|project experience)/iu.test(text)) available.add('work_experience')
  if (/(专业技能|技能|技术栈|skills?|tech stack|java|python|typescript|spring|redis|mysql)/iu.test(text)) available.add('skills')
  if (/(https?:\/\/|github\.com|gitlab\.com|作品集|portfolio)/iu.test(text)) available.add('portfolio_url')
  if (/\b\d{17}[\dX]\b/iu.test(text)) available.add('id_number')
  if (/(?:出生日期|生日)\s*[:：]?\s*(?:19|20)\d{2}/u.test(text)) available.add('birth_date')
  if (/(?:性别)\s*[:：]?\s*(?:男|女)/u.test(text)) available.add('gender')
  if (/(?:婚姻状况)\s*[:：]?\s*(?:已婚|未婚)/u.test(text)) available.add('marital_status')
  if (/(?:政治面貌)\s*[:：]?\s*\S+/u.test(text)) available.add('political_status')
  return available
}

function normalize(value: string): string {
  return ` ${value.toLocaleLowerCase('zh-CN').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()} `
}

function contains(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term))
}

function isPersonalData(semantic: ApplicationFormSemantic): boolean {
  return !new Set<ApplicationFormSemantic>([
    'resume_file',
    'skills',
    'target_role',
    'consent',
    'unknown',
  ]).has(semantic)
}

function count(fields: readonly ApplicationFormFieldPreview[], category: ApplicationFormFieldCategory): number {
  return fields.filter((field) => field.category === category).length
}

function normalizeOfficialUrl(value: string): string {
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    if (
      url.protocol !== 'https:'
      || url.username !== ''
      || url.password !== ''
      || (url.port !== '' && url.port !== '443')
      || hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
      || isIP(hostname) !== 0
    ) throw new Error()
    url.hash = ''
    return url.toString()
  } catch {
    throw new Error('application_form_official_url_invalid')
  }
}

function redactUrl(value: string): string {
  const url = new URL(value)
  url.search = ''
  url.hash = ''
  return url.toString()
}

function requireText(value: string, name: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`invalid_${name}`)
  return normalized
}
