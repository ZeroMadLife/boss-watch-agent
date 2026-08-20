import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  LocalGateAService,
  SqliteGateAStore,
} from '../src/gate-a.ts'
import {
  SqliteResumeMatchStore,
  type ResumeMatchResult,
} from '../src/resume-matching.ts'
import type { BossWatchDataSource } from '../src/domain.ts'
import { registerBossWatchTools } from '../src/tools.ts'

const MATCH: ResumeMatchResult = {
  matchId: 'resume-match:gate-a-fixture',
  strategyVersion: 'local-evidence-match-v3',
  createdAt: '2026-08-19T04:00:00.000Z',
  applicationId: 'application:gate-a-fixture',
  jd: {
    company: '虚构星河科技',
    role: '后端工程师',
    capturedAt: '2026-08-19T03:00:00.000Z',
    contentHash: 'a'.repeat(64),
  },
  resume: {
    resumeVersionId: 'resume-version:gate-a-fixture',
    contentHash: 'b'.repeat(64),
    mediaType: 'application/pdf',
  },
  extraction: { status: 'text_extracted', characterCount: 2048 },
  resumeSummary: {
    education: { highestLevel: '硕士', status: 'observed' },
    cohorts: ['2027'],
    locations: ['上海'],
    technologies: ['Java'],
    capabilities: ['Backend Engineering'],
    projects: {
      total: 1,
      directions: [{ label: 'Backend Engineering', count: 1 }],
      detection: 'section_blocks',
    },
  },
  hardConstraints: [],
  skills: {
    required: ['Java', 'Backend Engineering'],
    matched: ['Java', 'Backend Engineering'],
    missing: [],
    requiredTechnologies: ['Java'],
    matchedTechnologies: ['Java'],
    missingTechnologies: [],
    requiredCapabilities: ['Backend Engineering'],
    matchedCapabilities: ['Backend Engineering'],
    missingCapabilities: [],
  },
  score: 86,
  matchLevel: 'strong',
  evidence: [],
  gaps: [],
  risks: [],
  requiresGateA: true,
}

test('persists an idempotent Gate A confirmation bound to the exact match snapshot', () => {
  const matches = new SqliteResumeMatchStore(':memory:')
  const approvals = new SqliteGateAStore(':memory:')
  matches.save(MATCH)
  const service = new LocalGateAService({
    matches,
    approvals,
    now: () => new Date('2026-08-19T05:00:00.000Z'),
  })

  try {
    const first = service.confirm({ matchId: MATCH.matchId })
    const replay = service.confirm({ matchId: MATCH.matchId })

    assert.deepEqual(replay, first)
    assert.equal(first.applicationId, MATCH.applicationId)
    assert.equal(first.resumeVersionId, MATCH.resume.resumeVersionId)
    assert.equal(first.jdContentHash, MATCH.jd.contentHash)
    assert.equal(first.resumeContentHash, MATCH.resume.contentHash)
    assert.equal(first.matchStrategyVersion, 'local-evidence-match-v3')
    assert.equal(first.approvedAt, '2026-08-19T05:00:00.000Z')
    assert.equal(first.decision, 'proceed')
    assert.equal(first.externalAction, 'not_authorized')
    assert.deepEqual(approvals.getByMatchId(MATCH.matchId), first)
    assert.deepEqual(approvals.list({ applicationId: MATCH.applicationId }), [first])
  } finally {
    approvals.close()
    matches.close()
  }
})

test('fails closed when the requested match does not exist', () => {
  const matches = new SqliteResumeMatchStore(':memory:')
  const approvals = new SqliteGateAStore(':memory:')
  const service = new LocalGateAService({ matches, approvals })

  try {
    assert.throws(
      () => service.confirm({ matchId: 'resume-match:missing' }),
      /gate_a_match_not_found/u,
    )
    assert.equal(approvals.list().length, 0)
  } finally {
    approvals.close()
    matches.close()
  }
})

test('exposes explicit local Gate A confirmation through DSH without authorizing an external action', async () => {
  const context = new Context()
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  const matches = new SqliteResumeMatchStore(':memory:')
  const approvals = new SqliteGateAStore(':memory:')
  matches.save(MATCH)
  const gateA = new LocalGateAService({ matches, approvals })
  const source: BossWatchDataSource = {
    async listJobs() { return [] },
    async listApplicationOverviews() { return [] },
    async getApplicationOverview() { return undefined },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  const register = registerBossWatchTools as unknown as (...args: unknown[]) => () => void
  const dispose = register(
    context,
    source,
    ...Array.from({ length: 26 }, () => undefined),
    gateA,
  )

  try {
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('gate-a-confirm'),
      name: 'boss_watch_gate_a_confirm',
      arguments: { matchId: MATCH.matchId },
    })
    assert.equal(result.isError, false)
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
    assert.match(text, /"decision":"proceed"/u)
    assert.match(text, /"externalAction":"not_authorized"/u)
    assert.doesNotMatch(text, /简历正文|项目经历/u)
  } finally {
    dispose()
    approvals.close()
    matches.close()
    await context.fiber.dispose()
  }
})
