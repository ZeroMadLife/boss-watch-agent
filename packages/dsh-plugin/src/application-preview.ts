import { createHash } from 'node:crypto'
import type { JobLead, JobLeadStore } from './job-lead.js'
import type { ResumeVersion, ResumeVersionStore } from './resume-version.js'

export interface ApplicationPreview {
  readonly previewId: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly strategyVersion: 'apply-preview-v1'
  readonly lead: Pick<JobLead, 'leadId' | 'company' | 'role' | 'cohort' | 'recruitmentType' | 'contentHash' | 'confidence'> & {
    readonly officialApplyUrl: string
  }
  readonly resume: ResumeVersion
  readonly page: {
    readonly url: string
    readonly hostname: string
    readonly navigation: 'not_started'
  }
  readonly knownFields: readonly {
    readonly field: 'company' | 'role' | 'cohort' | 'recruitmentType'
    readonly value: string
    readonly source: 'job_lead'
  }[]
  readonly form: {
    readonly status: 'not_loaded'
    readonly fields: readonly []
    readonly missing: readonly ['form_schema_not_loaded']
  }
  readonly requiresHuman: true
}

export class LocalApplicationPreviewService {
  readonly #leads: Pick<JobLeadStore, 'get'>
  readonly #resumes: Pick<ResumeVersionStore, 'get'>
  readonly #now: () => Date

  constructor(input: {
    leads: Pick<JobLeadStore, 'get'>
    resumes: Pick<ResumeVersionStore, 'get'>
    now?: () => Date
  }) {
    this.#leads = input.leads
    this.#resumes = input.resumes
    this.#now = input.now ?? (() => new Date())
  }

  preview(input: { leadId: string; resumeVersionId: string }): ApplicationPreview {
    const leadId = requireText(input.leadId, 'lead_id')
    const lead = this.#leads.get(leadId)
    if (lead === undefined) throw new Error('apply_lead_not_found')
    if (lead.confidence !== 'human_confirmed' && lead.confidence !== 'jd_verified') {
      throw new Error('apply_lead_not_verified')
    }
    if (lead.officialApplyUrl === undefined) throw new Error('apply_official_url_missing')
    const url = parseOfficialApplyUrl(lead.officialApplyUrl)
    const resume = this.#resumes.get(input.resumeVersionId)
    if (resume === undefined) throw new Error('apply_resume_not_found')
    const now = this.#now()
    const createdAt = now.toISOString()
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString()
    const previewId = `apply-preview:${createHash('sha256')
      .update(`${lead.leadId}\n${lead.contentHash}\n${resume.resumeVersionId}\n${resume.contentHash}`)
      .digest('hex')}`
    const knownFields = [
      field('company', lead.company),
      field('role', lead.role),
      ...lead.cohort === undefined ? [] : [field('cohort', lead.cohort)],
      ...lead.recruitmentType === undefined ? [] : [field('recruitmentType', lead.recruitmentType)],
    ]
    return {
      previewId,
      createdAt,
      expiresAt,
      strategyVersion: 'apply-preview-v1',
      lead: {
        leadId: lead.leadId,
        company: lead.company,
        role: lead.role,
        ...lead.cohort === undefined ? {} : { cohort: lead.cohort },
        ...lead.recruitmentType === undefined ? {} : { recruitmentType: lead.recruitmentType },
        contentHash: lead.contentHash,
        confidence: lead.confidence,
        officialApplyUrl: url.toString(),
      },
      resume,
      page: { url: url.toString(), hostname: url.hostname, navigation: 'not_started' },
      knownFields,
      form: { status: 'not_loaded', fields: [], missing: ['form_schema_not_loaded'] },
      requiresHuman: true,
    }
  }
}

function field(
  name: 'company' | 'role' | 'cohort' | 'recruitmentType',
  value: string,
): { readonly field: typeof name; readonly value: string; readonly source: 'job_lead' } {
  return { field: name, value, source: 'job_lead' }
}

function parseOfficialApplyUrl(value: string): URL {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') throw new Error()
    url.hash = ''
    return url
  } catch {
    throw new Error('apply_official_url_invalid')
  }
}

function requireText(value: string, name: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`invalid_${name}`)
  return normalized
}
