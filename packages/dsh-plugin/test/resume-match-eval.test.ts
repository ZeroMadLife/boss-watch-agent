import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { evaluateResumeMatchGold, type ResumeMatchGoldCase } from '../src/resume-match-eval.ts'

const FIXTURE_URL = new URL('./fixtures/resume-match-gold-v1.json', import.meta.url)

async function loadCases(): Promise<ResumeMatchGoldCase[]> {
  return JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as ResumeMatchGoldCase[]
}

test('passes the fictional Gold and Badcase regression set without returning raw text', async () => {
  const report = await evaluateResumeMatchGold(await loadCases(), {
    now: () => new Date('2026-08-18T10:00:00.000Z'),
  })

  assert.equal(report.schemaVersion, 'resume-match-gold-v1')
  assert.equal(report.strategyVersion, 'local-evidence-match-v3')
  assert.equal(report.caseCount, 10)
  assert.equal(report.passedCaseCount, 10)
  assert.equal(report.failedCaseCount, 0)
  assert.equal(report.badcaseCount, 7)
  assert.equal(report.badcaseRegressionCount, 0)
  assert.equal(report.requiredSkills.f1, 1)
  assert.equal(report.matchedSkills.f1, 1)
  assert.equal(report.hardConstraints.accuracy, 1)
  assert.equal(report.matchLevelAccuracy, 1)
  const serialized = JSON.stringify(report)
  assert.equal(serialized.includes('候选人甲'), false)
  assert.equal(serialized.includes('负责跨团队协作'), false)
})

test('reports a changed Gold expectation as a named regression', async () => {
  const [baseline] = await loadCases()
  if (baseline === undefined) throw new Error('missing_resume_match_eval_fixture')
  const changed: ResumeMatchGoldCase = {
    ...baseline,
    caseId: 'intentional-regression-check',
    tags: ['badcase'],
    gold: {
      ...baseline.gold,
      matchedSkills: [],
    },
  }
  const report = await evaluateResumeMatchGold([changed], {
    now: () => new Date('2026-08-18T10:00:00.000Z'),
  })

  assert.equal(report.failedCaseCount, 1)
  assert.deepEqual(report.failedCaseIds, ['intentional-regression-check'])
  assert.equal(report.badcaseRegressionCount, 1)
  assert.equal(report.matchedSkills.falsePositive, baseline.gold.matchedSkills.length)
})
