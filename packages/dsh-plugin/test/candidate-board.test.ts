import assert from 'node:assert/strict'
import test from 'node:test'
import type { BossWatchDataSource, JobSummary } from '../src/domain.ts'
import { SqliteJobLeadStore } from '../src/job-lead.ts'
import { LocalCandidateBoardService } from '../src/candidate-board.ts'

test('builds a bounded board from source leads and captured BOSS jobs without fuzzy merging', async () => {
  const jobs: JobSummary[] = [{
    applicationId: 'application:boss-fixture',
    company: '虚构云图科技',
    role: '后端工程师',
    jobUrl: 'https://www.zhipin.com/job_detail/fixture-board.html',
    capturedAt: '2026-08-19T01:00:00.000Z',
    contentHash: 'b'.repeat(64),
  }]
  const source: BossWatchDataSource = {
    async listJobs(limit) { return jobs.slice(0, limit) },
    async listApplicationOverviews() { return [] },
    async getApplicationOverview() { return undefined },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  const leads = new SqliteJobLeadStore(':memory:')
  leads.upsert([{
    leadId: 'lead:gankinterview_campus:fixture',
    sourceKind: 'gankinterview_campus',
    sourceRecordId: 'fixture',
    company: '虚构云图科技',
    role: '后端工程师',
    city: '上海',
    cohort: '2027届',
    channelUrl: 'https://careers.example.invalid/fixture',
    fetchedAt: '2026-08-19T00:00:00.000Z',
    rawRef: 'gankinterview://campus/fixture',
    contentHash: 'a'.repeat(64),
    confidence: 'source_only',
  }])

  try {
    const board = await new LocalCandidateBoardService({ source, leads }).list({ limit: 10 })
    assert.equal(board.length, 2)
    assert.deepEqual(board.map(item => item.candidateId), [
      'application:boss-fixture',
      'lead:gankinterview_campus:fixture',
    ])
    assert.deepEqual(board[0], {
      candidateId: 'application:boss-fixture',
      recordKind: 'captured_job',
      sourceKind: 'boss_visible',
      company: '虚构云图科技',
      role: '后端工程师',
      jobUrl: 'https://www.zhipin.com/job_detail/fixture-board.html',
      capturedAt: '2026-08-19T01:00:00.000Z',
      confidence: 'captured_jd',
      jdStatus: 'complete',
      nextAction: 'match_resume',
    })
    assert.equal(board[1]?.jdStatus, 'source_summary')
    assert.equal(board[1]?.nextAction, 'verify_official_jd')
  } finally {
    leads.close()
  }
})

test('rejects an invalid board limit before reading local facts', async () => {
  let reads = 0
  const source: BossWatchDataSource = {
    async listJobs() { reads += 1; return [] },
    async listApplicationOverviews() { return [] },
    async getApplicationOverview() { return undefined },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  const leads = { list() { reads += 1; return [] } }
  const service = new LocalCandidateBoardService({ source, leads })
  await assert.rejects(() => service.list({ limit: 0 }), /invalid_candidate_board_limit/u)
  assert.equal(reads, 0)
})
