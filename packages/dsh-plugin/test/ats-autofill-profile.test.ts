import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LocalAtsAutofillProfileService,
  SqliteAtsAutofillProfileStore,
} from '../src/ats-autofill-profile.ts'
import type { ResumeVersion } from '../src/resume-version.ts'

const RESUME: ResumeVersion = {
  resumeVersionId: `resume-version:${'a'.repeat(64)}`,
  displayName: '候选人甲-后端开发',
  localArtifactRef: `local-resume://sha256:${'a'.repeat(64)}`,
  contentHash: 'a'.repeat(64),
  mediaType: 'application/pdf',
  byteSize: 1024,
  createdAt: '2026-08-20T02:00:00.000Z',
}

test('extracts one persistent ATS profile per exact resume snapshot', async () => {
  const store = new SqliteAtsAutofillProfileStore(':memory:')
  let extractionCount = 0
  const service = new LocalAtsAutofillProfileService({
    store,
    resumes: {
      async readText() {
        extractionCount += 1
        return {
          resumeVersion: RESUME,
          text: [
            '候选人甲',
            'candidate@example.invalid | 13800000000 | 现居地：福州',
            '2024.09 - 至今 某某大学 计算机技术 硕士 2027届',
            '性别：男 | 出生日期：2001/2/3',
            'GitHub: https://github.com/example/candidate',
          ].join('\n'),
          extractionStatus: 'text_extracted' as const,
          characterCount: 140,
          sourceByteHash: RESUME.contentHash,
        }
      },
    },
    now: () => new Date('2026-08-20T03:00:00.000Z'),
  })

  const first = await service.getOrCreate(RESUME)
  const second = await service.getOrCreate(RESUME)

  assert.equal(extractionCount, 1)
  assert.deepEqual(second, first)
  assert.deepEqual(first.values, {
    fullName: '候选人甲',
    email: 'candidate@example.invalid',
    phone: '13800000000',
    currentCity: '福州',
    school: '某某大学',
    major: '计算机技术',
    education: '硕士',
    graduationYear: '2027',
    birthDate: '2001-02-03',
    gender: '男',
    portfolioUrl: 'https://github.com/example/candidate',
  })
  assert.deepEqual(first.availableSemantics, [
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
    'portfolio_url',
  ])
  store.close()
})

test('coalesces concurrent requests for the same resume extraction', async () => {
  const store = new SqliteAtsAutofillProfileStore(':memory:')
  let extractionCount = 0
  const service = new LocalAtsAutofillProfileService({
    store,
    resumes: {
      async readText() {
        extractionCount += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        return {
          resumeVersion: RESUME,
          text: '姓名：候选人甲\n邮箱：candidate@example.invalid',
          extractionStatus: 'text_extracted' as const,
          characterCount: 42,
          sourceByteHash: RESUME.contentHash,
        }
      },
    },
  })

  const [first, second] = await Promise.all([
    service.getOrCreate(RESUME),
    service.getOrCreate(RESUME),
  ])

  assert.equal(extractionCount, 1)
  assert.equal(first.contentHash, second.contentHash)
  store.close()
})
