import { createHash } from 'node:crypto'
import type { BossWatchDataSource } from './domain.js'
import type { LocalResumeImportService, ResumeTextContent } from './resume-version.js'

export type ResumeMatchLevel = 'strong' | 'moderate' | 'weak' | 'insufficient_evidence'
export type ResumeConstraintStatus = 'matched' | 'unmatched' | 'unknown'

export interface ResumeMatchConstraint {
  readonly field: 'education' | 'cohort' | 'location' | 'experience'
  readonly status: ResumeConstraintStatus
  readonly required?: string
  readonly observed?: string
}

export interface ResumeMatchResult {
  readonly matchId: string
  readonly strategyVersion: 'local-evidence-match-v2'
  readonly createdAt: string
  readonly applicationId: string
  readonly jd: {
    readonly company: string
    readonly role: string
    readonly capturedAt: string
    readonly contentHash: string
  }
  readonly resume: {
    readonly resumeVersionId: string
    readonly contentHash: string
    readonly mediaType: string
  }
  readonly extraction: {
    readonly status: ResumeTextContent['extractionStatus']
    readonly characterCount: number
  }
  readonly hardConstraints: readonly ResumeMatchConstraint[]
  readonly skills: {
    readonly required: readonly string[]
    readonly matched: readonly string[]
    readonly missing: readonly string[]
  }
  readonly score: number
  readonly matchLevel: ResumeMatchLevel
  readonly evidence: readonly {
    readonly kind: 'skill' | 'hard_constraint'
    readonly item: string
    readonly status: ResumeConstraintStatus | 'matched'
  }[]
  readonly gaps: readonly string[]
  readonly risks: readonly string[]
  readonly requiresGateA: true
}

export class LocalResumeMatchingService {
  readonly #source: Pick<BossWatchDataSource, 'getJob'>
  readonly #resumes: Pick<LocalResumeImportService, 'readText'>
  readonly #now: () => Date

  constructor(input: {
    readonly source: Pick<BossWatchDataSource, 'getJob'>
    readonly resumes: Pick<LocalResumeImportService, 'readText'>
    readonly now?: () => Date
  }) {
    this.#source = input.source
    this.#resumes = input.resumes
    this.#now = input.now ?? (() => new Date())
  }

  async match(input: { readonly applicationId: string; readonly resumeVersionId: string }): Promise<ResumeMatchResult> {
    const applicationId = requireText(input.applicationId, 'application_id')
    const job = await this.#source.getJob(applicationId)
    if (job === undefined) throw new Error('resume_match_job_not_found')
    const resume = await this.#resumes.readText(input.resumeVersionId)
    const normalizedJd = normalizeText(job.description)
    const normalizedResume = normalizeText(resume.text)
    const requiredSkills = extractRequiredSkills(normalizedJd)
    const matchedSkills = requiredSkills.filter((skill) => containsSkill(normalizedResume, skill))
    const missingSkills = requiredSkills.filter((skill) => !matchedSkills.includes(skill))
    const hardConstraints = extractHardConstraints(normalizedJd, normalizedResume)
    const score = calibratedScore(
      scoreMatch(requiredSkills.length, matchedSkills.length, hardConstraints),
      resume.extractionStatus,
      hardConstraints,
    )
    const matchLevel = levelFor(score, resume.extractionStatus, requiredSkills.length, hardConstraints)
    const createdAt = this.#now().toISOString()
    const matchId = `resume-match:${createHash('sha256')
      .update(`${applicationId}\n${job.contentHash}\n${resume.resumeVersion.contentHash}\nlocal-evidence-match-v2`)
      .digest('hex')}`
    const evidence = [
      ...matchedSkills.map((item) => ({ kind: 'skill' as const, item, status: 'matched' as const })),
      ...missingSkills.map((item) => ({ kind: 'skill' as const, item, status: 'unknown' as const })),
      ...hardConstraints.map((constraint) => ({
        kind: 'hard_constraint' as const,
        item: constraint.field,
        status: constraint.status,
      })),
    ]
    const gaps = [
      ...missingSkills.map((skill) => `missing_skill:${skill}`),
      ...hardConstraints
        .filter((constraint) => constraint.status === 'unmatched')
        .map((constraint) => `hard_constraint:${constraint.field}`),
      ...hardConstraints
        .filter((constraint) => constraint.status === 'unknown')
        .map((constraint) => `evidence_missing:${constraint.field}`),
    ]
    const risks = [
      ...(resume.extractionStatus === 'text_truncated' ? ['resume_text_truncated'] : []),
      ...(requiredSkills.length === 0 ? ['jd_skill_terms_not_observed'] : []),
      ...(hardConstraints.some((constraint) => constraint.status === 'unknown') ? ['hard_constraint_not_observed'] : []),
    ]
    return {
      matchId,
      strategyVersion: 'local-evidence-match-v2',
      createdAt,
      applicationId,
      jd: {
        company: job.company,
        role: job.role,
        capturedAt: job.capturedAt,
        contentHash: job.contentHash,
      },
      resume: {
        resumeVersionId: resume.resumeVersion.resumeVersionId,
        contentHash: resume.resumeVersion.contentHash,
        mediaType: resume.resumeVersion.mediaType,
      },
      extraction: {
        status: resume.extractionStatus,
        characterCount: resume.characterCount,
      },
      hardConstraints,
      skills: {
        required: requiredSkills,
        matched: matchedSkills,
        missing: missingSkills,
      },
      score,
      matchLevel,
      evidence,
      gaps,
      risks,
      requiresGateA: true,
    }
  }
}

const SKILL_ALIASES: readonly [string, readonly string[]][] = [
  ['TypeScript', ['typescript', 'ts']],
  ['JavaScript', ['javascript', 'js']],
  ['Python', ['python']],
  ['Java', ['java']],
  ['Go', ['golang', 'go']],
  ['C++', ['c++']],
  ['Rust', ['rust']],
  ['React', ['react', 'react.js']],
  ['Vue', ['vue', 'vue.js']],
  ['Node.js', ['node.js', 'nodejs']],
  ['Spring', ['spring', 'spring boot', 'springboot']],
  ['FastAPI', ['fastapi']],
  ['SQL', ['sql']],
  ['MySQL', ['mysql']],
  ['PostgreSQL', ['postgresql', 'postgres']],
  ['Redis', ['redis']],
  ['Kafka', ['kafka']],
  ['Docker', ['docker']],
  ['Kubernetes', ['kubernetes', 'k8s']],
  ['Linux', ['linux']],
  ['Git', ['git', 'github', 'gitlab']],
  ['AWS', ['aws', 'amazon web services']],
  ['RAG', ['rag', 'retrieval augmented generation', '检索增强生成']],
  ['LLM', ['llm', '大语言模型', '语言模型']],
  ['Agent', ['agent', '智能体']],
  ['PyTorch', ['pytorch']],
  ['TensorFlow', ['tensorflow']],
  ['Flink', ['flink']],
  ['Spark', ['spark']],
]

const CITY_TERMS: readonly string[] = [
  '北京', '上海', '广州', '深圳', '杭州', '南京', '苏州', '成都', '武汉', '西安', '重庆', '天津',
  '宁波', '厦门', '福州', '合肥', '郑州', '长沙', '青岛', '济南', '大连', '无锡', '东莞', '珠海',
]

function extractRequiredSkills(jd: string): string[] {
  return SKILL_ALIASES
    .filter(([, aliases]) => aliases.some((alias) => containsTerm(jd, alias)))
    .map(([name]) => name)
}

function extractHardConstraints(jd: string, resume: string): ResumeMatchConstraint[] {
  const constraints: ResumeMatchConstraint[] = []
  const education = educationRequirement(jd)
  if (education !== undefined) {
    const observed = firstMatching(resume, ['博士', '硕士', '本科', '大专', 'phd', 'master', 'bachelor'])
    constraints.push({
      field: 'education',
      status: observed === undefined ? 'unknown' : educationCompatible(education, observed) ? 'matched' : 'unmatched',
      required: education,
      ...observed === undefined ? {} : { observed },
    })
  }
  const jdYears = uniqueYearMatches(jd)
  if (jdYears.length > 0) {
    const resumeYears = uniqueYearMatches(resume)
    constraints.push({
      field: 'cohort',
      status: resumeYears.length === 0 ? 'unknown' : resumeYears.some((year) => jdYears.includes(year)) ? 'matched' : 'unmatched',
      required: jdYears.join(', '),
      ...resumeYears.length === 0 ? {} : { observed: resumeYears.join(', ') },
    })
  }
  const jdCities = CITY_TERMS.filter((city) => jd.includes(city))
  if (jdCities.length > 0) {
    const resumeCities = CITY_TERMS.filter((city) => resume.includes(city))
    const matchedCity = resumeCities.find((city) => jdCities.includes(city))
    constraints.push({
      field: 'location',
      status: resumeCities.length === 0 ? 'unknown' : matchedCity === undefined ? 'unmatched' : 'matched',
      required: jdCities.join(', '),
      ...resumeCities.length === 0 ? {} : { observed: resumeCities.join(', ') },
    })
  }
  const experienceMatch = jd.match(/(\d+)\s*(?:年?以上|年及以上|年经验|年工作经验)/u)
  if (experienceMatch?.[1] !== undefined) {
    const minimum = Number(experienceMatch[1])
    const resumeMatch = resume.match(/(\d+)\s*(?:年?以上|年及以上|年经验|年工作经验)/u)
    const observed = resumeMatch?.[1] === undefined ? undefined : Number(resumeMatch[1])
    constraints.push({
      field: 'experience',
      status: observed === undefined ? 'unknown' : observed >= minimum ? 'matched' : 'unmatched',
      required: `${minimum}年`,
      ...observed === undefined ? {} : { observed: `${observed}年` },
    })
  }
  return constraints
}

function scoreMatch(requiredSkillCount: number, matchedSkillCount: number, constraints: readonly ResumeMatchConstraint[]): number {
  if (requiredSkillCount === 0 && constraints.length === 0) return 0
  const skillScore = requiredSkillCount === 0 ? 35 : (matchedSkillCount / requiredSkillCount) * 60
  const constraintScore = constraints.length === 0
    ? 25
    : constraints.reduce((total, constraint) => total + (constraint.status === 'matched' ? 30 : constraint.status === 'unknown' ? 15 : 0), 0) / constraints.length
  return Math.max(0, Math.min(100, Math.round(skillScore + constraintScore + 10)))
}

function calibratedScore(
  rawScore: number,
  extractionStatus: ResumeTextContent['extractionStatus'],
  constraints: readonly ResumeMatchConstraint[],
): number {
  if (extractionStatus === 'text_truncated') return Math.min(rawScore, 24)
  if (constraints.some((constraint) => constraint.status === 'unmatched')) return Math.min(rawScore, 49)
  if (constraints.some((constraint) => constraint.status === 'unknown')) return Math.min(rawScore, 74)
  return rawScore
}

function levelFor(
  score: number,
  extractionStatus: ResumeTextContent['extractionStatus'],
  requiredSkillCount: number,
  constraints: readonly ResumeMatchConstraint[],
): ResumeMatchLevel {
  if (extractionStatus === 'text_truncated' || (requiredSkillCount === 0 && constraints.length === 0)) {
    return 'insufficient_evidence'
  }
  if (constraints.some((constraint) => constraint.status === 'unmatched')) {
    return score >= 25 ? 'weak' : 'insufficient_evidence'
  }
  if (constraints.some((constraint) => constraint.status === 'unknown') && score >= 50) return 'moderate'
  if (score >= 75) return 'strong'
  if (score >= 50) return 'moderate'
  if (score >= 25) return 'weak'
  return 'insufficient_evidence'
}

function educationRequirement(text: string): string | undefined {
  const explicitMinimums: readonly [string, RegExp][] = [
    ['大专', /大专(?:及以上|以上)/u],
    ['本科', /本科(?:及以上|以上)/u],
    ['硕士', /硕士(?:及以上|以上)/u],
    ['博士', /博士(?:及以上|以上)/u],
    ['bachelor', /bachelor(?:'?s)?(?: degree)?\s*(?:or above|or higher|and above|\+)/iu],
    ['master', /master(?:'?s)?(?: degree)?\s*(?:or above|or higher|and above|\+)/iu],
    ['phd', /ph\.?d\.?(?: degree)?\s*(?:or above|or higher|and above|\+)?/iu],
  ]
  const explicit = explicitMinimums.find(([, pattern]) => pattern.test(text))
  if (explicit !== undefined) return explicit[0]

  return firstMatchingByPosition(text, ['博士', '硕士', '本科', '大专', 'phd', 'master', 'bachelor'])
}

function educationCompatible(required: string, observed: string): boolean {
  const rank = (value: string): number => value.includes('博士') || value.includes('phd') ? 4 : value.includes('硕士') || value.includes('master') ? 3 : value.includes('本科') || value.includes('bachelor') ? 2 : 1
  return rank(observed) >= rank(required)
}

function firstMatching(text: string, terms: readonly string[]): string | undefined {
  return terms.find((term) => containsTerm(text, term))
}

function firstMatchingByPosition(text: string, terms: readonly string[]): string | undefined {
  return terms
    .map((term) => ({ term, index: text.indexOf(term) }))
    .filter((candidate) => candidate.index >= 0 && containsTerm(text, candidate.term))
    .sort((left, right) => left.index - right.index)[0]?.term
}

function uniqueYearMatches(text: string): string[] {
  return [...new Set([...text.matchAll(/(20\d{2})\s*(?:届|校招|毕业)/gu)].map((match) => match[1]).filter((year): year is string => year !== undefined))]
}

function containsSkill(text: string, skill: string): boolean {
  const aliases = SKILL_ALIASES.find(([name]) => name === skill)?.[1] ?? [skill]
  return aliases.some((alias) => containsTerm(text, alias))
}

function containsTerm(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const asciiWord = /^[a-z0-9+.# -]+$/u.test(term)
  return asciiWord
    ? new RegExp(`(?<![a-z0-9.])${escaped}(?![a-z0-9.])`, 'iu').test(text)
    : text.includes(term)
}

function normalizeText(value: string): string {
  return value.toLocaleLowerCase('zh-CN').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
}

function requireText(value: string, name: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`invalid_${name}`)
  return normalized
}
