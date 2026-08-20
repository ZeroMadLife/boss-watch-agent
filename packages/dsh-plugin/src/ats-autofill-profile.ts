import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  LocalResumeImportService,
  ResumeTextContent,
  ResumeVersion,
} from './resume-version.js'

export type AtsAutofillSemantic =
  | 'resume_file'
  | 'full_name'
  | 'email'
  | 'phone'
  | 'location'
  | 'school'
  | 'major'
  | 'education'
  | 'graduation_year'
  | 'birth_date'
  | 'gender'
  | 'work_experience'
  | 'skills'
  | 'portfolio_url'

export interface AtsAutofillProfileValues {
  readonly fullName?: string | undefined
  readonly email?: string | undefined
  readonly phone?: string | undefined
  readonly currentCity?: string | undefined
  readonly school?: string | undefined
  readonly major?: string | undefined
  readonly education?: string | undefined
  readonly graduationYear?: string | undefined
  readonly birthDate?: string | undefined
  readonly gender?: string | undefined
  readonly portfolioUrl?: string | undefined
}

export interface AtsAutofillProfile {
  readonly profileId: string
  readonly strategyVersion: 'ats-autofill-profile-v1'
  readonly resumeVersionId: string
  readonly resumeContentHash: string
  readonly extractionStatus: ResumeTextContent['extractionStatus']
  readonly characterCount: number
  readonly availableSemantics: readonly AtsAutofillSemantic[]
  readonly values: AtsAutofillProfileValues
  readonly updatedAt: string
  readonly contentHash: string
}

export interface AtsAutofillProfileStore {
  get(resumeVersionId: string): AtsAutofillProfile | undefined
  save(profile: AtsAutofillProfile): AtsAutofillProfile
  close(): void
}

interface AtsAutofillProfileRow {
  profile_json: string
}

const STRATEGY_VERSION = 'ats-autofill-profile-v1' as const
const SEMANTIC_ORDER: readonly AtsAutofillSemantic[] = [
  'resume_file',
  'full_name',
  'email',
  'phone',
  'location',
  'school',
  'major',
  'education',
  'graduation_year',
  'birth_date',
  'gender',
  'work_experience',
  'skills',
  'portfolio_url',
]
const VALUE_ORDER: readonly (keyof AtsAutofillProfileValues)[] = [
  'fullName',
  'email',
  'phone',
  'currentCity',
  'school',
  'major',
  'education',
  'graduationYear',
  'birthDate',
  'gender',
  'portfolioUrl',
]

export class SqliteAtsAutofillProfileStore implements AtsAutofillProfileStore {
  readonly #database: DatabaseSync
  #closed = false

  constructor(path: string) {
    if (path.trim().length === 0) throw new Error('invalid_database_path')
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#database = new DatabaseSync(path)
    this.#database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS ats_autofill_profiles (
        resume_version_id TEXT PRIMARY KEY,
        resume_content_hash TEXT NOT NULL UNIQUE CHECK (length(resume_content_hash) = 64),
        profile_content_hash TEXT NOT NULL CHECK (length(profile_content_hash) = 64),
        updated_at TEXT NOT NULL,
        profile_json TEXT NOT NULL
      );
    `)
  }

  get(resumeVersionId: string): AtsAutofillProfile | undefined {
    this.#assertOpen()
    const row = this.#database.prepare(
      'SELECT profile_json FROM ats_autofill_profiles WHERE resume_version_id = ?',
    ).get(requireText(resumeVersionId, 'resume_version_id')) as AtsAutofillProfileRow | undefined
    return row === undefined ? undefined : parseProfile(row.profile_json)
  }

  save(profile: AtsAutofillProfile): AtsAutofillProfile {
    this.#assertOpen()
    const parsed = parseProfile(JSON.stringify(profile))
    this.#database.prepare(`
      INSERT INTO ats_autofill_profiles (
        resume_version_id, resume_content_hash, profile_content_hash, updated_at, profile_json
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(resume_version_id) DO UPDATE SET
        resume_content_hash = excluded.resume_content_hash,
        profile_content_hash = excluded.profile_content_hash,
        updated_at = excluded.updated_at,
        profile_json = excluded.profile_json
    `).run(
      parsed.resumeVersionId,
      parsed.resumeContentHash,
      parsed.contentHash,
      parsed.updatedAt,
      JSON.stringify(parsed),
    )
    return parsed
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#database.close()
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('ats_autofill_profile_store_closed')
  }
}

export class LocalAtsAutofillProfileService {
  readonly #store: AtsAutofillProfileStore
  readonly #resumes: Pick<LocalResumeImportService, 'readText'>
  readonly #now: () => Date
  readonly #inFlight = new Map<string, Promise<AtsAutofillProfile>>()

  constructor(input: {
    store: AtsAutofillProfileStore
    resumes: Pick<LocalResumeImportService, 'readText'>
    now?: () => Date
  }) {
    this.#store = input.store
    this.#resumes = input.resumes
    this.#now = input.now ?? (() => new Date())
  }

  async getOrCreate(resume: ResumeVersion): Promise<AtsAutofillProfile> {
    const existing = this.#store.get(resume.resumeVersionId)
    if (existing !== undefined && existing.resumeContentHash === resume.contentHash) return existing
    const current = this.#inFlight.get(resume.resumeVersionId)
    if (current !== undefined) return current
    const pending = this.#extractAndSave(resume)
    this.#inFlight.set(resume.resumeVersionId, pending)
    try {
      return await pending
    } finally {
      this.#inFlight.delete(resume.resumeVersionId)
    }
  }

  async #extractAndSave(resume: ResumeVersion): Promise<AtsAutofillProfile> {
    const extracted = await this.#resumes.readText(resume.resumeVersionId)
    if (
      extracted.resumeVersion.resumeVersionId !== resume.resumeVersionId
      || extracted.resumeVersion.contentHash !== resume.contentHash
      || extracted.sourceByteHash !== resume.contentHash
    ) throw new Error('ats_autofill_resume_identity_mismatch')
    return this.#store.save(buildProfile(resume, extracted, this.#now().toISOString()))
  }
}

function buildProfile(
  resume: ResumeVersion,
  extracted: ResumeTextContent,
  updatedAt: string,
): AtsAutofillProfile {
  const values = extractValues(extracted.text)
  const available = new Set<AtsAutofillSemantic>(['resume_file'])
  for (const semantic of valueSemantics(values)) available.add(semantic)
  if (/(工作经历|实习经历|项目经历|work experience|employment|internship|project experience)/iu.test(extracted.text)) {
    available.add('work_experience')
  }
  if (/(专业技能|技能|技术栈|skills?|tech stack|java|python|typescript|spring|redis|mysql)/iu.test(extracted.text)) {
    available.add('skills')
  }
  const availableSemantics = SEMANTIC_ORDER.filter((semantic) => available.has(semantic))
  const canonical = JSON.stringify({
    strategyVersion: STRATEGY_VERSION,
    resumeVersionId: resume.resumeVersionId,
    resumeContentHash: resume.contentHash,
    extractionStatus: extracted.extractionStatus,
    characterCount: extracted.characterCount,
    availableSemantics,
    values: VALUE_ORDER.flatMap((field) => values[field] === undefined ? [] : [[field, values[field]]]),
  })
  return {
    profileId: `ats-autofill-profile:${resume.contentHash}`,
    strategyVersion: STRATEGY_VERSION,
    resumeVersionId: resume.resumeVersionId,
    resumeContentHash: resume.contentHash,
    extractionStatus: extracted.extractionStatus,
    characterCount: extracted.characterCount,
    availableSemantics,
    values,
    updatedAt,
    contentHash: createHash('sha256').update(canonical).digest('hex'),
  }
}

function extractValues(text: string): AtsAutofillProfileValues {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const firstLine = lines[0] ?? ''
  return normalizeValues({
    fullName: matchValue(text, [/(?:^|\n)\s*(?:姓名|name)\s*[:：]\s*([^\n]{2,40})(?:\n|$)/iu])
      ?? (/^[\p{Script=Han}A-Za-z .·-]{2,20}$/u.test(firstLine)
        && !/(简历|求职|开发|工程师|大学|学院|resume|curriculum)/iu.test(firstLine)
        ? firstLine
        : undefined),
    email: matchValue(text, [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu], 0),
    phone: matchValue(text, [/(?:\+?86[- ]?)?1[3-9]\d{9}/u], 0),
    currentCity: matchValue(text, [
      /(?:现居地|所在地|所在城市|居住地|location|city)\s*[:：]\s*([^\n|｜,，]{2,40})/iu,
    ]),
    school: matchValue(text, [
      /(?:毕业院校|学校|school|university)\s*[:：]\s*([^\n]{2,80})(?:\n|$)/iu,
      /([\p{Script=Han}A-Za-z·]{2,40}(?:大学|学院))/u,
    ]),
    major: matchValue(text, [
      /(?:专业名称|所学专业|专业|major)\s*[:：]\s*([^\n]{2,60})(?:\n|$)/iu,
      /(计算机科学与技术|计算机技术|软件工程|人工智能|数据科学与大数据技术|信息安全)/u,
    ]),
    education: matchValue(text, [/(博士|硕士|本科|大专|ph\.?d|master|bachelor|associate degree)/iu]),
    graduationYear: matchValue(text, [/(20\d{2})\s*(?:届|年毕业|毕业)/u]),
    birthDate: normalizeDateValue(matchValue(text, [
      /(?:出生日期|生日|date of birth|birth date)\s*[:：]\s*((?:19|20)\d{2}[./-]\d{1,2}[./-]\d{1,2})/iu,
    ])),
    gender: matchValue(text, [/(?:性别|gender)\s*[:：]\s*(男|女|male|female)/iu]),
    portfolioUrl: matchValue(text, [/(https?:\/\/(?:www\.)?(?:github|gitlab)\.com\/[^\s)]+)/iu], 0),
  })
}

function valueSemantics(values: AtsAutofillProfileValues): readonly AtsAutofillSemantic[] {
  return [
    ...(values.fullName === undefined ? [] : ['full_name' as const]),
    ...(values.email === undefined ? [] : ['email' as const]),
    ...(values.phone === undefined ? [] : ['phone' as const]),
    ...(values.currentCity === undefined ? [] : ['location' as const]),
    ...(values.school === undefined ? [] : ['school' as const]),
    ...(values.major === undefined ? [] : ['major' as const]),
    ...(values.education === undefined ? [] : ['education' as const]),
    ...(values.graduationYear === undefined ? [] : ['graduation_year' as const]),
    ...(values.birthDate === undefined ? [] : ['birth_date' as const]),
    ...(values.gender === undefined ? [] : ['gender' as const]),
    ...(values.portfolioUrl === undefined ? [] : ['portfolio_url' as const]),
  ]
}

function normalizeValues(values: AtsAutofillProfileValues): AtsAutofillProfileValues {
  return Object.fromEntries(VALUE_ORDER.flatMap((field) => {
    const value = values[field]
    if (value === undefined) return []
    const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 500)
    return normalized.length === 0 ? [] : [[field, normalized]]
  })) as AtsAutofillProfileValues
}

function parseProfile(value: string): AtsAutofillProfile {
  const parsed = JSON.parse(value) as Partial<AtsAutofillProfile>
  if (
    parsed.strategyVersion !== STRATEGY_VERSION
    || typeof parsed.profileId !== 'string'
    || typeof parsed.resumeVersionId !== 'string'
    || typeof parsed.resumeContentHash !== 'string'
    || !/^[a-f0-9]{64}$/u.test(parsed.resumeContentHash)
    || parsed.profileId !== `ats-autofill-profile:${parsed.resumeContentHash}`
    || (parsed.extractionStatus !== 'text_extracted' && parsed.extractionStatus !== 'text_truncated')
    || typeof parsed.characterCount !== 'number'
    || !Number.isInteger(parsed.characterCount)
    || parsed.characterCount < 1
    || !Array.isArray(parsed.availableSemantics)
    || parsed.availableSemantics.some((semantic) => !SEMANTIC_ORDER.includes(semantic))
    || parsed.values === undefined
    || typeof parsed.updatedAt !== 'string'
    || typeof parsed.contentHash !== 'string'
    || !/^[a-f0-9]{64}$/u.test(parsed.contentHash)
  ) throw new Error('ats_autofill_profile_invalid')
  const normalized = buildStoredProfile({
    profileId: parsed.profileId,
    strategyVersion: parsed.strategyVersion,
    resumeVersionId: parsed.resumeVersionId,
    resumeContentHash: parsed.resumeContentHash,
    extractionStatus: parsed.extractionStatus,
    characterCount: parsed.characterCount,
    availableSemantics: SEMANTIC_ORDER.filter((semantic) => parsed.availableSemantics?.includes(semantic)),
    values: normalizeValues(parsed.values),
    updatedAt: parsed.updatedAt,
    contentHash: parsed.contentHash,
  })
  if (profileHash(normalized) !== normalized.contentHash) throw new Error('ats_autofill_profile_hash_mismatch')
  return normalized
}

function buildStoredProfile(profile: AtsAutofillProfile): AtsAutofillProfile {
  return profile
}

function profileHash(profile: Omit<AtsAutofillProfile, 'contentHash' | 'updatedAt' | 'profileId'>): string {
  const canonical = JSON.stringify({
    strategyVersion: profile.strategyVersion,
    resumeVersionId: profile.resumeVersionId,
    resumeContentHash: profile.resumeContentHash,
    extractionStatus: profile.extractionStatus,
    characterCount: profile.characterCount,
    availableSemantics: profile.availableSemantics,
    values: VALUE_ORDER.flatMap((field) => profile.values[field] === undefined ? [] : [[field, profile.values[field]]]),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

function matchValue(text: string, patterns: readonly RegExp[], group = 1): string | undefined {
  for (const pattern of patterns) {
    const value = pattern.exec(text)?.[group]
    if (value !== undefined) return value.trim()
  }
  return undefined
}

function normalizeDateValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const parts = value.split(/[./-]/u)
  if (parts.length !== 3) return undefined
  const [year, month, day] = parts
  if (year === undefined || month === undefined || day === undefined) return undefined
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}

function requireText(value: string, name: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`invalid_${name}`)
  return normalized
}
