import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { LocalResumeImportService, SqliteResumeVersionStore } from '../src/resume-version.ts'

test('previews a controlled local resume without persisting content, then imports an immutable version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-resume-'))
  const store = new SqliteResumeVersionStore(':memory:')
  const service = new LocalResumeImportService({
    resumeRoot: root,
    store,
    now: () => new Date('2026-08-18T03:00:00.000Z'),
  })
  const content = Buffer.from('fictional resume evidence')
  await writeFile(join(root, 'candidate-v1.pdf'), content)

  try {
    const preview = await service.preview({ fileName: 'candidate-v1.pdf', displayName: '候选人简历 v1' })
    assert.equal(preview.mediaType, 'application/pdf')
    assert.equal(preview.byteSize, content.byteLength)
    assert.equal(preview.contentHash, createHash('sha256').update(content).digest('hex'))
    assert.equal(preview.expiresAt, '2026-08-18T03:15:00.000Z')
    assert.equal(preview.requiresConfirmation, true)
    assert.deepEqual(store.list(), [])
    assert.deepEqual(await readdir(join(root, '.artifacts')), [])

    const applied = await service.apply(preview.previewToken)
    assert.equal(applied.reused, false)
    assert.equal(applied.resumeVersion.resumeVersionId, `resume-version:${preview.contentHash}`)
    assert.equal(applied.resumeVersion.localArtifactRef, `local-resume://sha256:${preview.contentHash}`)
    assert.deepEqual(store.list(), [applied.resumeVersion])
    const artifact = await readFile(join(root, '.artifacts', `${preview.contentHash}.pdf`))
    assert.deepEqual(artifact, content)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects a resume changed after preview and does not create a version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-resume-stale-'))
  const store = new SqliteResumeVersionStore(':memory:')
  const service = new LocalResumeImportService({ resumeRoot: root, store })
  await writeFile(join(root, 'candidate-v1.docx'), 'version one')

  try {
    const preview = await service.preview({ fileName: 'candidate-v1.docx' })
    await writeFile(join(root, 'candidate-v1.docx'), 'version two')
    await assert.rejects(() => service.apply(preview.previewToken), /resume_preview_stale/u)
    assert.deepEqual(store.list(), [])
    assert.deepEqual(await readdir(join(root, '.artifacts')), [])
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('deduplicates identical resume content and preserves explicit version ancestry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-resume-history-'))
  const store = new SqliteResumeVersionStore(':memory:')
  let clock = 0
  const service = new LocalResumeImportService({
    resumeRoot: root,
    store,
    now: () => new Date(`2026-08-18T04:0${clock++}:00.000Z`),
  })
  await writeFile(join(root, 'candidate-v1.md'), '# v1')

  try {
    const firstPreview = await service.preview({ fileName: 'candidate-v1.md' })
    const first = await service.apply(firstPreview.previewToken)

    await writeFile(join(root, 'candidate-copy.md'), '# v1')
    const duplicatePreview = await service.preview({ fileName: 'candidate-copy.md' })
    assert.equal(duplicatePreview.existingResumeVersionId, first.resumeVersion.resumeVersionId)
    const duplicate = await service.apply(duplicatePreview.previewToken)
    assert.equal(duplicate.reused, true)
    assert.equal(duplicate.resumeVersion.resumeVersionId, first.resumeVersion.resumeVersionId)

    await writeFile(join(root, 'candidate-v2.md'), '# v2')
    const secondPreview = await service.preview({
      fileName: 'candidate-v2.md',
      supersedesResumeVersionId: first.resumeVersion.resumeVersionId,
    })
    const second = await service.apply(secondPreview.previewToken)
    assert.equal(second.resumeVersion.supersedesResumeVersionId, first.resumeVersion.resumeVersionId)
    assert.equal(store.list().length, 2)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects path traversal, unsupported files, and symbolic links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-resume-invalid-'))
  const outside = join(root, '..', `outside-${Date.now()}.pdf`)
  const store = new SqliteResumeVersionStore(':memory:')
  const service = new LocalResumeImportService({ resumeRoot: root, store })
  await writeFile(outside, 'outside')
  await writeFile(join(root, 'candidate.png'), 'image')
  await symlink(outside, join(root, 'linked.pdf'))

  try {
    await assert.rejects(() => service.preview({ fileName: '../outside.pdf' }), /invalid_resume_file_name/u)
    await assert.rejects(() => service.preview({ fileName: 'candidate.png' }), /unsupported_resume_file_type/u)
    await assert.rejects(() => service.preview({ fileName: 'linked.pdf' }), /resume_file_symlink_not_allowed/u)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
    await rm(outside, { force: true })
  }
})

test('keeps PDF and DOCX extraction failures local and uses stable errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-resume-extraction-'))
  const store = new SqliteResumeVersionStore(':memory:')
  const observedMediaTypes: string[] = []
  const service = new LocalResumeImportService({
    resumeRoot: root,
    store,
    async extractText(_filePath, mediaType) {
      observedMediaTypes.push(mediaType)
      if (mediaType === 'application/pdf') return 'fictional PDF text'
      throw new Error('resume_text_extraction_unavailable')
    },
  })
  await writeFile(join(root, 'candidate.pdf'), 'fictional pdf bytes')
  await writeFile(join(root, 'candidate.docx'), 'fictional docx bytes')

  try {
    const pdfPreview = await service.preview({ fileName: 'candidate.pdf' })
    const pdf = await service.apply(pdfPreview.previewToken)
    const pdfText = await service.readText(pdf.resumeVersion.resumeVersionId)
    assert.equal(pdfText.extractionStatus, 'text_extracted')
    assert.equal(pdfText.text, 'fictional PDF text')

    const docxPreview = await service.preview({ fileName: 'candidate.docx' })
    const docx = await service.apply(docxPreview.previewToken)
    await assert.rejects(
      () => service.readText(docx.resumeVersion.resumeVersionId),
      /resume_text_extraction_unavailable/u,
    )
    assert.deepEqual(observedMediaTypes, [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ])
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('marks oversized extracted text as truncated instead of returning a strong-evidence status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-watch-resume-truncated-'))
  const store = new SqliteResumeVersionStore(':memory:')
  const service = new LocalResumeImportService({
    resumeRoot: root,
    store,
    async extractText() {
      return 'x'.repeat(200_001)
    },
  })
  await writeFile(join(root, 'candidate.pdf'), 'fictional pdf bytes')

  try {
    const preview = await service.preview({ fileName: 'candidate.pdf' })
    const imported = await service.apply(preview.previewToken)
    const text = await service.readText(imported.resumeVersion.resumeVersionId)
    assert.equal(text.extractionStatus, 'text_truncated')
    assert.equal(text.characterCount, 200_000)
    assert.equal(text.text.length, 200_000)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
