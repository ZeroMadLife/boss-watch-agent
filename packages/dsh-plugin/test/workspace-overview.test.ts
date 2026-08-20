import assert from 'node:assert/strict'
import test from 'node:test'
import type { BossWatchDataSource, JobSummary } from '../src/domain.ts'
import { SqliteFeishuTargetStore } from '../src/feishu-projection.ts'
import { SqliteJobLeadStore } from '../src/job-lead.ts'
import { SqliteResumeVersionStore } from '../src/resume-version.ts'
import { LocalWorkspaceOverviewService } from '../src/workspace-overview.ts'

test('routes a new local workspace through resume, source verification, and application preparation', async () => {
  const jobs: JobSummary[] = []
  let localFactReads = 0
  let resumeMatchCount = 0
  let gateAApprovalCount = 0
  const source: BossWatchDataSource = {
    async listJobs() {
      localFactReads += 1
      return [...jobs]
    },
    async listApplicationOverviews() { return [] },
    async getApplicationOverview() { return undefined },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  const leads = new SqliteJobLeadStore(':memory:')
  const resumes = new SqliteResumeVersionStore(':memory:')
  const feishuTargets = new SqliteFeishuTargetStore(':memory:')
  const service = new LocalWorkspaceOverviewService({
    source,
    databaseReady: true,
    leads,
    resumes,
    resumeMatches: { count: () => resumeMatchCount },
    gateAApprovals: { count: () => gateAApprovalCount },
    feishuTargets,
    searchGuard: {
      async searchGuardStatus() {
        return {
          state: 'risk_cooldown' as const,
          guarded: true as const,
          retryAfterMs: 600_000,
          observedAt: '2026-08-19T01:00:00.000Z',
          scope: 'controller_process' as const,
          resetsOnRestart: true as const,
        }
      },
    },
    sourceAvailability: {
      gankInterview: false,
      bossVisible: true,
      fileImport: true,
      clipboardImport: true,
      visualImport: true,
    },
  })

  try {
    const fresh = await service.inspect()
    assert.equal(fresh.phase, 'resume_setup')
    assert.deepEqual(fresh.counts, {
      resumeVersions: 0,
      jobLeads: 0,
      sourceOnlyLeads: 0,
      verifiedLeads: 0,
      capturedJobs: 0,
      resumeMatches: 0,
      gateAApprovals: 0,
      feishuTargets: 0,
    })
    assert.equal(fresh.readOnly, true)
    assert.equal(fresh.externalNetworkAccess, false)
    assert.deepEqual(fresh.bossSearchGuard, {
      state: 'risk_cooldown',
      guarded: true,
      retryAfterMs: 600_000,
      observedAt: '2026-08-19T01:00:00.000Z',
      scope: 'controller_process',
      resetsOnRestart: true,
    })
    assert.equal(fresh.sourceChannels.find(channel => channel.sourceId === 'gankinterview')?.state, 'setup_required')
    assert.equal(fresh.recommendedActions[0]?.toolName, 'boss_watch_resume_import_preview')

    resumes.save({
      resumeVersionId: `resume-version:${'a'.repeat(64)}`,
      displayName: '虚构候选人-后端方向',
      localArtifactRef: `local-resume://sha256:${'a'.repeat(64)}`,
      contentHash: 'a'.repeat(64),
      mediaType: 'application/pdf',
      byteSize: 1024,
      createdAt: '2026-08-18T00:00:00.000Z',
    })
    leads.upsert([{
      leadId: 'lead:gankinterview_campus:fixture',
      sourceKind: 'gankinterview_campus',
      sourceRecordId: 'fixture',
      company: '虚构云图科技',
      role: '后端工程师',
      channelUrl: 'https://careers.example.invalid/jobs/fixture',
      fetchedAt: '2026-08-18T00:00:00.000Z',
      rawRef: 'gankinterview://campus/fixture',
      contentHash: 'b'.repeat(64),
      confidence: 'source_only',
    }])

    const needsVerification = await service.inspect()
    assert.equal(needsVerification.phase, 'lead_verification')
    assert.equal(needsVerification.counts.sourceOnlyLeads, 1)
    assert.equal(needsVerification.recommendedActions[0]?.toolName, 'boss_watch_lead_list')
    assert.equal(needsVerification.recommendedActions[0]?.reasonCode, 'official_jd_verification_required')

    leads.upsert([{
      leadId: 'lead:gankinterview_campus:fixture',
      sourceKind: 'gankinterview_campus',
      sourceRecordId: 'fixture',
      company: '虚构云图科技',
      role: '后端工程师',
      channelUrl: 'https://careers.example.invalid/jobs/fixture',
      officialApplyUrl: 'https://careers.example.invalid/jobs/fixture',
      fetchedAt: '2026-08-18T00:05:00.000Z',
      rawRef: 'gankinterview://campus/fixture',
      contentHash: 'b'.repeat(64),
      confidence: 'human_confirmed',
    }])
    jobs.push({
      applicationId: 'application-fixture',
      company: '虚构云图科技',
      role: '后端工程师',
      jobUrl: 'https://www.zhipin.com/job_detail/fixture.html',
      capturedAt: '2026-08-18T00:10:00.000Z',
      contentHash: 'c'.repeat(64),
    })
    feishuTargets.saveTarget({
      targetId: 'feishu-target:fixture',
      baseToken: 'base_fixture',
      tableId: 'table_fixture',
      identity: 'user',
      schemaHash: 'd'.repeat(64),
      mapping: {},
      createdAt: '2026-08-18T00:15:00.000Z',
      updatedAt: '2026-08-18T00:15:00.000Z',
    })

    const readyToMatch = await service.inspect()
    assert.equal(readyToMatch.phase, 'match_ready')
    assert.deepEqual(
      readyToMatch.recommendedActions.map(action => action.toolName),
      ['boss_watch_resume_match'],
    )

    resumeMatchCount = 1
    const gatePending = await service.inspect()
    assert.equal(gatePending.phase, 'match_ready')
    assert.equal(gatePending.counts.resumeMatches, 1)
    assert.deepEqual(
      gatePending.recommendedActions.map(action => action.toolName),
      ['boss_watch_gate_a_confirm'],
    )

    gateAApprovalCount = 1
    const ready = await service.inspect()
    assert.equal(ready.phase, 'application_preparation')
    assert.equal(ready.counts.verifiedLeads, 1)
    assert.equal(ready.counts.capturedJobs, 1)
    assert.equal(ready.counts.gateAApprovals, 1)
    assert.equal(ready.counts.feishuTargets, 1)
    assert.deepEqual(
      ready.recommendedActions.map(action => action.toolName),
      ['boss_watch_apply_preview'],
    )
    assert.equal(localFactReads, 5)
  } finally {
    feishuTargets.close()
    resumes.close()
    leads.close()
  }
})

test('reports local runtime setup without probing any external source', async () => {
  let reads = 0
  const source: BossWatchDataSource = {
    async listJobs() {
      reads += 1
      throw new Error('must_not_read_missing_database')
    },
    async listApplicationOverviews() { return [] },
    async getApplicationOverview() { return undefined },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  const service = new LocalWorkspaceOverviewService({
    source,
    databaseReady: false,
    sourceAvailability: {
      gankInterview: true,
      bossVisible: true,
      fileImport: false,
      clipboardImport: false,
      visualImport: false,
    },
  })

  const overview = await service.inspect()
  assert.equal(overview.phase, 'local_runtime_setup')
  assert.equal(overview.databaseReady, false)
  assert.equal(overview.recommendedActions[0]?.actionId, 'start_local_runtime')
  assert.equal(reads, 0)
})

test('keeps local facts available when the controller guard status cannot be read', async () => {
  const source: BossWatchDataSource = {
    async countJobs() { return 0 },
    async listJobs() { return [] },
    async listApplicationOverviews() { return [] },
    async getApplicationOverview() { return undefined },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  const service = new LocalWorkspaceOverviewService({
    source,
    databaseReady: true,
    searchGuard: {
      async searchGuardStatus() { throw new Error('controller_unavailable') },
    },
    sourceAvailability: {
      gankInterview: false,
      bossVisible: true,
      fileImport: false,
      clipboardImport: false,
      visualImport: false,
    },
  })

  const overview = await service.inspect()
  assert.equal(overview.phase, 'resume_setup')
  assert.deepEqual(overview.bossSearchGuard, {
    state: 'controller_unavailable',
    guarded: true,
    scope: 'controller_process',
    resetsOnRestart: true,
  })
})

test('counts a captured BOSS job as a ready job source checkpoint', async () => {
  const source: BossWatchDataSource = {
    async countJobs() { return 1 },
    async listJobs() { throw new Error('exact_count_should_be_used') },
    async listApplicationOverviews() { return [] },
    async getApplicationOverview() { return undefined },
    async getJob() { return undefined },
    async listTimeline() { return [] },
  }
  const service = new LocalWorkspaceOverviewService({
    source,
    databaseReady: true,
    sourceAvailability: {
      gankInterview: false,
      bossVisible: true,
      fileImport: false,
      clipboardImport: false,
      visualImport: false,
    },
  })

  const overview = await service.inspect()
  const jobCheckpoint = overview.checkpoints.find(checkpoint => checkpoint.checkpointId === 'job_leads')
  assert.deepEqual(jobCheckpoint, { checkpointId: 'job_leads', state: 'ready', count: 1 })
})
