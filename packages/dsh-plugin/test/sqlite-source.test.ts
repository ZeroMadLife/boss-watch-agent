import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteBossWatchDataSource } from '../src/sqlite-source.ts'

test('reads captured jobs and append-only timeline without writing to SQLite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-watch-dsh-'))
  const databasePath = join(dir, 'boss-watch.sqlite3')
  const database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TABLE application_artifacts (
      artifact_id TEXT PRIMARY KEY, application_id TEXT NOT NULL, kind TEXT NOT NULL,
      content TEXT NOT NULL, content_hash TEXT NOT NULL, artifact_ref TEXT NOT NULL,
      created_at TEXT NOT NULL, metadata_json TEXT NOT NULL
    );
    CREATE TABLE application_events (
      event_id TEXT PRIMARY KEY, application_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL, trace_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
      actor TEXT NOT NULL, event_type TEXT NOT NULL, event_json TEXT NOT NULL, artifact_id TEXT
    );
  `)
  const applicationId = 'application-fixture-1'
  const eventId = `event-${randomUUID()}`
  const occurredAt = '2026-08-16T01:00:00.000Z'
  database
    .prepare('INSERT INTO application_artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      'artifact-1', applicationId, 'job_description', 'TypeScript 后端工程师', 'a'.repeat(64),
      'local-artifact://application/artifact-1', occurredAt, JSON.stringify({}),
    )
  database
    .prepare('INSERT INTO application_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      eventId, applicationId, 1, 'fixture-1', 'trace-1', occurredAt, 'agent',
      'job_description_captured', JSON.stringify({
        type: 'job_description_captured',
        payload: { company: '示例公司', role: 'TypeScript 后端工程师', jobUrl: 'https://example.invalid/jobs/1' },
      }), 'artifact-1',
    )
  database
    .prepare('INSERT INTO application_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      `event-${randomUUID()}`, applicationId, 2, 'fixture-2', 'trace-2', occurredAt, 'human',
      'status_change_proposed', JSON.stringify({
        type: 'status_change_proposed',
        payload: { to: 'awaiting_gate_b' },
      }), null,
    )
  database
    .prepare('INSERT INTO application_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      `event-${randomUUID()}`, applicationId, 3, 'fixture-3', 'trace-3', occurredAt, 'agent',
      'recruiter_message_captured', JSON.stringify({
        type: 'recruiter_message_captured',
        payload: { conversationId: 'conversation-1', messageId: 'message-1' },
      }), null,
    )
  database
    .prepare('INSERT INTO application_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      `event-${randomUUID()}`, applicationId, 4, 'fixture-4', 'trace-4', occurredAt, 'human',
      'interview_note_recorded', JSON.stringify({
        type: 'interview_note_recorded',
        payload: { interviewId: 'interview-1', stage: 'first_interview' },
      }), null,
    )
  database.close()

  try {
    const source = new SqliteBossWatchDataSource(databasePath)
    assert.deepEqual(await source.listJobs(20), [{
      applicationId,
      company: '示例公司',
      role: 'TypeScript 后端工程师',
      jobUrl: 'https://example.invalid/jobs/1',
      capturedAt: occurredAt,
      contentHash: 'a'.repeat(64),
    }])
    assert.equal((await source.getJob(applicationId))?.description, 'TypeScript 后端工程师')
    assert.deepEqual((await source.listJobRevisions?.(applicationId))?.map((revision) => revision.contentHash), ['a'.repeat(64)])
    assert.deepEqual((await source.listTimeline(applicationId)).map((event) => event.type), [
      'job_description_captured',
      'status_change_proposed',
      'recruiter_message_captured',
      'interview_note_recorded',
    ])
    assert.deepEqual(await source.getApplicationOverview(applicationId), {
      applicationId,
      company: '示例公司',
      role: 'TypeScript 后端工程师',
      jobUrl: 'https://example.invalid/jobs/1',
      capturedAt: occurredAt,
      contentHash: 'a'.repeat(64),
      progressState: 'status_proposed',
      eventCount: 4,
      recruiterMessageCount: 1,
      interviewNoteCount: 1,
      progressSignalCount: 0,
      latestEventType: 'interview_note_recorded',
      latestEventAt: occurredAt,
      proposedStatus: 'awaiting_gate_b',
    })

    const readOnlyCheck = new DatabaseSync(databasePath, { readOnly: true })
    assert.throws(() => readOnlyCheck.exec('CREATE TABLE should_not_exist (value TEXT)'))
    readOnlyCheck.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reports a missing database as source_unavailable at the data source seam', async () => {
  const source = new SqliteBossWatchDataSource('/tmp/boss-watch-dsh-missing.sqlite3')
  await assert.rejects(() => source.listJobs(20), /source_unavailable/u)
})

test('uses the latest JD revision per application in the tracker list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-watch-dsh-latest-'))
  const databasePath = join(dir, 'boss-watch.sqlite3')
  const database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TABLE application_artifacts (
      artifact_id TEXT PRIMARY KEY, application_id TEXT NOT NULL, kind TEXT NOT NULL,
      content TEXT NOT NULL, content_hash TEXT NOT NULL, artifact_ref TEXT NOT NULL,
      created_at TEXT NOT NULL, metadata_json TEXT NOT NULL
    );
    CREATE TABLE application_events (
      event_id TEXT PRIMARY KEY, application_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL, trace_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
      actor TEXT NOT NULL, event_type TEXT NOT NULL, event_json TEXT NOT NULL, artifact_id TEXT
    );
  `)

  const addJob = (input: {
    applicationId: string
    artifactId: string
    eventId: string
    sequence: number
    company: string
    role: string
    createdAt: string
  }) => {
    database.prepare('INSERT INTO application_artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      input.artifactId,
      input.applicationId,
      'job_description',
      input.role,
      input.artifactId.padEnd(64, 'a').slice(0, 64),
      `local-artifact://${input.artifactId}`,
      input.createdAt,
      JSON.stringify({}),
    )
    database.prepare('INSERT INTO application_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      input.eventId,
      input.applicationId,
      input.sequence,
      `fixture-${input.eventId}`,
      `trace-${input.eventId}`,
      input.createdAt,
      'agent',
      'job_description_captured',
      JSON.stringify({
        type: 'job_description_captured',
        payload: { company: input.company, role: input.role, jobUrl: `https://example.invalid/${input.eventId}` },
      }),
      input.artifactId,
    )
  }

  addJob({
    applicationId: 'application-old-revision',
    artifactId: 'artifact-old',
    eventId: 'event-old',
    sequence: 1,
    company: '旧公司名',
    role: '旧岗位名',
    createdAt: '2026-08-15T04:00:00.000Z',
  })
  addJob({
    applicationId: 'application-old-revision',
    artifactId: 'artifact-new',
    eventId: 'event-new',
    sequence: 2,
    company: '新公司名',
    role: '新岗位名',
    createdAt: '2026-08-16T04:00:00.000Z',
  })
  addJob({
    applicationId: 'application-other',
    artifactId: 'artifact-other',
    eventId: 'event-other',
    sequence: 1,
    company: '另一家公司',
    role: '另一岗位',
    createdAt: '2026-08-14T04:00:00.000Z',
  })
  database.close()

  try {
    const source = new SqliteBossWatchDataSource(databasePath)
    assert.deepEqual((await source.listJobs(2)).map(({ applicationId, company, role }) => ({ applicationId, company, role })), [
      { applicationId: 'application-old-revision', company: '新公司名', role: '新岗位名' },
      { applicationId: 'application-other', company: '另一家公司', role: '另一岗位' },
    ])
    assert.deepEqual((await source.listApplicationOverviews(2)).map(({ applicationId, company, role }) => ({ applicationId, company, role })), [
      { applicationId: 'application-old-revision', company: '新公司名', role: '新岗位名' },
      { applicationId: 'application-other', company: '另一家公司', role: '另一岗位' },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
