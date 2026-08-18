import { createHash } from 'node:crypto'
import type { BossWatchDataSource, JobDetails } from './domain.js'
import {
  LocalResumeMatchingService,
  type ResumeConstraintStatus,
  type ResumeMatchConstraint,
  type ResumeMatchLevel,
  type ResumeMatchResult,
} from './resume-matching.js'
import type { ResumeTextContent, ResumeTextExtractionStatus, ResumeVersion } from './resume-version.js'

export interface ResumeMatchGoldCase {
  readonly caseId: string
  readonly tags?: readonly string[]
  readonly jd: {
    readonly company: string
    readonly role: string
    readonly description: string
  }
  readonly resume: {
    readonly text: string
    readonly extractionStatus?: ResumeTextExtractionStatus
  }
  readonly gold: {
    readonly requiredSkills: readonly string[]
    readonly matchedSkills: readonly string[]
    readonly hardConstraints: Partial<Record<ResumeMatchConstraint['field'], ResumeConstraintStatus>>
    readonly matchLevel: ResumeMatchLevel
    readonly scoreRange: { readonly min: number; readonly max: number }
  }
}

export interface LabelMetrics {
  readonly truePositive: number
  readonly falsePositive: number
  readonly falseNegative: number
  readonly precision: number
  readonly recall: number
  readonly f1: number
}

export interface ResumeMatchEvalCaseResult {
  readonly caseId: string
  readonly tags: readonly string[]
  readonly passed: boolean
  readonly requiredSkills: LabelMetrics
  readonly matchedSkills: LabelMetrics
  readonly hardConstraints: {
    readonly correct: number
    readonly total: number
    readonly accuracy: number
  }
  readonly expectedMatchLevel: ResumeMatchLevel
  readonly actualMatchLevel: ResumeMatchLevel
  readonly expectedScoreRange: { readonly min: number; readonly max: number }
  readonly actualScore: number
  readonly actual: {
    readonly requiredSkills: readonly string[]
    readonly matchedSkills: readonly string[]
    readonly hardConstraints: Partial<Record<ResumeMatchConstraint['field'], ResumeConstraintStatus>>
  }
}

export interface ResumeMatchEvalReport {
  readonly schemaVersion: 'resume-match-gold-v1'
  readonly strategyVersion: ResumeMatchResult['strategyVersion']
  readonly evaluatedAt: string
  readonly caseCount: number
  readonly passedCaseCount: number
  readonly failedCaseCount: number
  readonly failedCaseIds: readonly string[]
  readonly badcaseCount: number
  readonly badcaseRegressionCount: number
  readonly requiredSkills: LabelMetrics
  readonly matchedSkills: LabelMetrics
  readonly hardConstraints: {
    readonly correct: number
    readonly total: number
    readonly accuracy: number
  }
  readonly matchLevelAccuracy: number
  readonly cases: readonly ResumeMatchEvalCaseResult[]
}

/**
 * Evaluate the deterministic matcher against fictional Gold cases.
 * Raw JD and resume text are consumed in-memory and never returned in the report.
 */
export async function evaluateResumeMatchGold(
  cases: readonly ResumeMatchGoldCase[],
  options: { readonly now?: () => Date } = {},
): Promise<ResumeMatchEvalReport> {
  if (cases.length === 0) throw new Error('resume_match_eval_empty')
  const now = options.now ?? (() => new Date())
  const seenCaseIds = new Set<string>()
  const results: ResumeMatchEvalCaseResult[] = []
  const requiredTotals = emptyCounts()
  const matchedTotals = emptyCounts()
  let constraintCorrect = 0
  let constraintTotal = 0
  let matchLevelCorrect = 0

  for (const goldCase of cases) {
    validateGoldCase(goldCase, seenCaseIds)
    const result = await runGoldCase(goldCase, now)
    const requiredSkills = compareLabels(goldCase.gold.requiredSkills, result.skills.required)
    const matchedSkills = compareLabels(goldCase.gold.matchedSkills, result.skills.matched)
    addCounts(requiredTotals, requiredSkills)
    addCounts(matchedTotals, matchedSkills)

    const expectedConstraints = goldCase.gold.hardConstraints
    const actualConstraints = Object.fromEntries(
      result.hardConstraints.map((constraint) => [constraint.field, constraint.status]),
    ) as Partial<Record<ResumeMatchConstraint['field'], ResumeConstraintStatus>>
    const constraintFields = new Set([
      ...Object.keys(expectedConstraints),
      ...Object.keys(actualConstraints),
    ] as ResumeMatchConstraint['field'][])
    let caseConstraintCorrect = 0
    for (const field of constraintFields) {
      if (expectedConstraints[field] === actualConstraints[field]) caseConstraintCorrect += 1
    }
    constraintCorrect += caseConstraintCorrect
    constraintTotal += constraintFields.size

    const levelMatches = result.matchLevel === goldCase.gold.matchLevel
    if (levelMatches) matchLevelCorrect += 1
    const scoreMatches = result.score >= goldCase.gold.scoreRange.min && result.score <= goldCase.gold.scoreRange.max
    const passed = isPerfect(requiredSkills)
      && isPerfect(matchedSkills)
      && caseConstraintCorrect === constraintFields.size
      && levelMatches
      && scoreMatches
    results.push({
      caseId: goldCase.caseId,
      tags: goldCase.tags ?? [],
      passed,
      requiredSkills,
      matchedSkills,
      hardConstraints: {
        correct: caseConstraintCorrect,
        total: constraintFields.size,
        accuracy: ratio(caseConstraintCorrect, constraintFields.size),
      },
      expectedMatchLevel: goldCase.gold.matchLevel,
      actualMatchLevel: result.matchLevel,
      expectedScoreRange: goldCase.gold.scoreRange,
      actualScore: result.score,
      actual: {
        requiredSkills: result.skills.required,
        matchedSkills: result.skills.matched,
        hardConstraints: actualConstraints,
      },
    })
  }

  const passedCaseCount = results.filter((result) => result.passed).length
  const badcases = results.filter((result) => result.tags.includes('badcase'))
  return {
    schemaVersion: 'resume-match-gold-v1',
    strategyVersion: 'local-evidence-match-v2',
    evaluatedAt: now().toISOString(),
    caseCount: results.length,
    passedCaseCount,
    failedCaseCount: results.length - passedCaseCount,
    failedCaseIds: results.filter((result) => !result.passed).map((result) => result.caseId),
    badcaseCount: badcases.length,
    badcaseRegressionCount: badcases.filter((result) => !result.passed).length,
    requiredSkills: metrics(requiredTotals),
    matchedSkills: metrics(matchedTotals),
    hardConstraints: {
      correct: constraintCorrect,
      total: constraintTotal,
      accuracy: ratio(constraintCorrect, constraintTotal),
    },
    matchLevelAccuracy: ratio(matchLevelCorrect, results.length),
    cases: results,
  }
}

async function runGoldCase(goldCase: ResumeMatchGoldCase, now: () => Date): Promise<ResumeMatchResult> {
  const jdHash = sha256(goldCase.jd.description)
  const resumeHash = sha256(goldCase.resume.text)
  const applicationId = `application:resume-eval:${sha256(goldCase.caseId).slice(0, 16)}`
  const resumeVersionId = `resume-version:${resumeHash}`
  const job: JobDetails = {
    applicationId,
    company: goldCase.jd.company,
    role: goldCase.jd.role,
    jobUrl: `https://example.test/jobs/${encodeURIComponent(goldCase.caseId)}`,
    capturedAt: '2026-08-18T00:00:00.000Z',
    contentHash: jdHash,
    description: goldCase.jd.description,
    artifactRef: `local-artifact://resume-eval/${jdHash}`,
  }
  const resumeVersion: ResumeVersion = {
    resumeVersionId,
    displayName: `fixture-${goldCase.caseId}`,
    localArtifactRef: `local-resume://sha256:${resumeHash}`,
    contentHash: resumeHash,
    mediaType: 'text/markdown',
    byteSize: Buffer.byteLength(goldCase.resume.text, 'utf8'),
    createdAt: '2026-08-18T00:00:00.000Z',
  }
  const resume: ResumeTextContent = {
    resumeVersion,
    text: goldCase.resume.text,
    extractionStatus: goldCase.resume.extractionStatus ?? 'text_extracted',
    characterCount: goldCase.resume.text.length,
    sourceByteHash: resumeHash,
  }
  const source: Pick<BossWatchDataSource, 'getJob'> = {
    async getJob(requestedApplicationId) {
      return requestedApplicationId === applicationId ? job : undefined
    },
  }
  const matcher = new LocalResumeMatchingService({
    source,
    resumes: {
      async readText(requestedResumeVersionId) {
        if (requestedResumeVersionId !== resumeVersionId) throw new Error('resume_version_not_found')
        return resume
      },
    },
    now,
  })
  return matcher.match({ applicationId, resumeVersionId })
}

function validateGoldCase(goldCase: ResumeMatchGoldCase, seen: Set<string>): void {
  const caseId = goldCase.caseId.trim()
  if (caseId.length === 0 || seen.has(caseId)) throw new Error('invalid_resume_match_eval_case_id')
  seen.add(caseId)
  if (goldCase.jd.description.trim().length === 0 || goldCase.resume.text.trim().length === 0) {
    throw new Error('invalid_resume_match_eval_text')
  }
  validateLabels(goldCase.gold.requiredSkills)
  validateLabels(goldCase.gold.matchedSkills)
  const requiredSkills = new Set(goldCase.gold.requiredSkills)
  if (goldCase.gold.matchedSkills.some((skill) => !requiredSkills.has(skill))) {
    throw new Error('invalid_resume_match_eval_matched_skills')
  }
  if (!['strong', 'moderate', 'weak', 'insufficient_evidence'].includes(goldCase.gold.matchLevel)) {
    throw new Error('invalid_resume_match_eval_level')
  }
  if (
    goldCase.resume.extractionStatus !== undefined
    && !['text_extracted', 'text_truncated'].includes(goldCase.resume.extractionStatus)
  ) throw new Error('invalid_resume_match_eval_extraction_status')
  for (const status of Object.values(goldCase.gold.hardConstraints)) {
    if (status !== undefined && !['matched', 'unmatched', 'unknown'].includes(status)) {
      throw new Error('invalid_resume_match_eval_constraint_status')
    }
  }
  const { min, max } = goldCase.gold.scoreRange
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 100 || min > max) {
    throw new Error('invalid_resume_match_eval_score_range')
  }
}

function validateLabels(labels: readonly string[]): void {
  if (labels.some((label) => label.trim().length === 0) || new Set(labels).size !== labels.length) {
    throw new Error('invalid_resume_match_eval_labels')
  }
}

interface MutableCounts {
  truePositive: number
  falsePositive: number
  falseNegative: number
}

function emptyCounts(): MutableCounts {
  return { truePositive: 0, falsePositive: 0, falseNegative: 0 }
}

function addCounts(target: MutableCounts, source: LabelMetrics): void {
  target.truePositive += source.truePositive
  target.falsePositive += source.falsePositive
  target.falseNegative += source.falseNegative
}

function compareLabels(expectedValues: readonly string[], actualValues: readonly string[]): LabelMetrics {
  const expected = new Set(expectedValues)
  const actual = new Set(actualValues)
  let truePositive = 0
  for (const value of actual) {
    if (expected.has(value)) truePositive += 1
  }
  return metrics({
    truePositive,
    falsePositive: actual.size - truePositive,
    falseNegative: expected.size - truePositive,
  })
}

function metrics(counts: MutableCounts): LabelMetrics {
  const precision = ratio(counts.truePositive, counts.truePositive + counts.falsePositive)
  const recall = ratio(counts.truePositive, counts.truePositive + counts.falseNegative)
  const f1 = precision + recall === 0 ? 0 : round((2 * precision * recall) / (precision + recall))
  return { ...counts, precision, recall, f1 }
}

function isPerfect(value: LabelMetrics): boolean {
  return value.falsePositive === 0 && value.falseNegative === 0
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : round(numerator / denominator)
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
