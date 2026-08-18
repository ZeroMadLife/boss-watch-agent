export interface JobSummary {
  readonly applicationId: string
  readonly company: string
  readonly role: string
  readonly jobUrl?: string
  readonly capturedAt: string
  readonly contentHash: string
}

export interface JobDetails extends JobSummary {
  readonly description: string
  readonly artifactRef: string
}

export type JobRevision = JobDetails

export interface TimelineEvent {
  readonly sequence: number
  readonly eventId: string
  readonly applicationId: string
  readonly type: string
  readonly occurredAt: string
  readonly actor: string
  readonly payload?: JsonValue
}

export type ProgressState =
  | 'new'
  | 'conversation_active'
  | 'interview_notes'
  | 'signal_needs_review'
  | 'status_proposed'

export interface ApplicationOverview extends JobSummary {
  readonly progressState: ProgressState
  readonly eventCount: number
  readonly recruiterMessageCount: number
  readonly interviewNoteCount: number
  readonly progressSignalCount: number
  readonly latestEventType: string
  readonly latestEventAt: string
  readonly proposedStatus?: string
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue }

export interface BossWatchDataSource {
  countJobs?(): Promise<number>
  listJobs(limit: number): Promise<JobSummary[]>
  listApplicationOverviews(limit: number): Promise<ApplicationOverview[]>
  getApplicationOverview(applicationId: string): Promise<ApplicationOverview | undefined>
  getJob(applicationId: string): Promise<JobDetails | undefined>
  listJobRevisions?(applicationId: string): Promise<readonly JobRevision[]>
  listTimeline(applicationId: string): Promise<TimelineEvent[]>
}

export type BrowserStatus =
  | {
      readonly status: 'ready'
      readonly targetCount: 1
      readonly target: BrowserTarget
    }
  | {
      readonly status: 'no_supported_tab'
      readonly reason: 'no_boss_page'
      readonly targetCount: 0
    }
  | {
      readonly status: 'target_ambiguous'
      readonly reason: 'multiple_job_tabs'
      readonly targetCount: number
    }
  | {
      readonly status: 'human_required'
      readonly reason: 'login' | 'verification'
      readonly targetCount: number
    }
  | {
      readonly status: 'environment_interrupted'
      readonly reason: 'runtime_unavailable' | 'browser_disconnected' | 'controller_unavailable'
      readonly targetCount: 0
    }

export interface BrowserTarget {
  readonly pageKind: 'job_detail'
  readonly title?: string
  readonly url: string
}

export interface BrowserJobSummary {
  readonly externalJobId: string
  readonly role: string
  readonly company?: string
  readonly salary?: string
  readonly salaryStatus: 'available' | 'obfuscated' | 'missing'
  readonly experience?: string
  readonly education?: string
  readonly location?: string
  readonly jobUrl: string
}

export type BrowserApplicationFormControlType =
  | 'text'
  | 'email'
  | 'tel'
  | 'url'
  | 'number'
  | 'date'
  | 'month'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'file'
  | 'other'

export interface BrowserApplicationFormField {
  readonly fieldId: string
  readonly ordinal: number
  readonly controlType: BrowserApplicationFormControlType
  readonly inputType: string
  readonly label: string
  readonly name?: string
  readonly autocomplete?: string
  readonly required: boolean
  readonly disabled: boolean
  readonly readOnly: boolean
  readonly currentState: 'empty' | 'present' | 'checked' | 'unchecked'
  readonly metadataTrust: 'untrusted_page'
}

export type BrowserApplicationFormInspection =
  | {
      readonly status: 'ready'
      readonly targetCount: 1
      readonly page: {
        readonly pageKind: 'application_form'
        readonly title?: string
        readonly url: string
        readonly hostname: string
        readonly formHash: string
        readonly metadataTrust: 'untrusted_page'
      }
      readonly fields: readonly BrowserApplicationFormField[]
    }
  | {
      readonly status: 'no_supported_tab'
      readonly reason: 'official_page_not_open' | 'no_application_form'
      readonly targetCount: 0 | 1
    }
  | {
      readonly status: 'target_ambiguous'
      readonly reason: 'multiple_official_tabs'
      readonly targetCount: number
    }
  | {
      readonly status: 'human_required'
      readonly reason: 'login' | 'verification' | 'risk_control' | 'page_identity_mismatch'
      readonly targetCount: number
    }
  | {
      readonly status: 'page_adapter_mismatch'
      readonly reason: 'application_form'
      readonly targetCount: 1
    }
  | {
      readonly status: 'invalid_request'
      readonly reason: 'unsupported_official_url'
      readonly targetCount: 0
    }
  | {
      readonly status: 'environment_interrupted'
      readonly reason: 'runtime_unavailable' | 'browser_disconnected' | 'controller_unavailable'
      readonly targetCount: 0
    }

export type BrowserJobDiscovery =
  | {
      readonly status: 'ready'
      readonly discoveryId: string
      readonly targetCount: 1
      readonly target: {
        readonly pageKind: 'job_list'
        readonly title?: string
        readonly url: string
      }
      readonly jobs: readonly BrowserJobSummary[]
    }
  | {
      readonly status: 'no_supported_tab'
      readonly reason: 'no_boss_page' | 'no_job_cards' | 'no_job_list'
      readonly targetCount: 0 | 1
    }
  | {
      readonly status: 'target_ambiguous'
      readonly reason: 'multiple_boss_tabs'
      readonly targetCount: number
    }
  | {
      readonly status: 'human_required'
      readonly reason: 'login' | 'verification'
      readonly targetCount: number
    }
  | {
      readonly status: 'environment_interrupted'
      readonly reason: 'runtime_unavailable' | 'browser_disconnected' | 'controller_unavailable'
      readonly targetCount: 0
    }

export type BrowserCapture =
  | Exclude<BrowserStatus, { readonly status: 'ready' }>
  | {
      readonly status: 'page_adapter_mismatch'
      readonly reason: 'job_detail'
      readonly targetCount: 1
    }
  | {
      readonly status: 'ok'
      readonly applicationId: string
      readonly eventId: string
      readonly artifactId: string
      readonly artifactRef: string
      readonly contentHash: string
      readonly savedAt: string
      readonly deduplicated: boolean
      readonly job: {
        readonly externalJobId: string
        readonly company: string
        readonly role: string
        readonly jobUrl: string
        readonly pageRevision: string
      }
  }

export type BrowserConversationCapture =
  | {
      readonly status: 'no_supported_tab'
      readonly reason: 'no_boss_page' | 'no_conversation'
      readonly targetCount: 0
    }
  | {
      readonly status: 'target_ambiguous'
      readonly reason: 'multiple_conversation_tabs'
      readonly targetCount: number
    }
  | {
      readonly status: 'human_required'
      readonly reason: 'login' | 'verification'
      readonly targetCount: number
    }
  | {
      readonly status: 'environment_interrupted'
      readonly reason: 'runtime_unavailable' | 'browser_disconnected' | 'controller_unavailable'
      readonly targetCount: 0
    }
  | {
      readonly status: 'page_adapter_mismatch'
      readonly reason: 'conversation'
      readonly targetCount: 1
    }
  | {
      readonly status: 'ok'
      readonly applicationId: string
      readonly eventId: string
      readonly artifactId: string
      readonly artifactRef: string
      readonly contentHash: string
      readonly savedAt: string
      readonly deduplicated: boolean
      readonly conversation: {
        readonly conversationId: string
        readonly messageId: string
        readonly recruiterName: string
        readonly pageRevision: string
      }
    }

export type BrowserDiscoveredCapture = BrowserCapture | {
  readonly status: 'invalid_request'
  readonly reason: 'discovery_expired' | 'job_not_found'
  readonly targetCount: 0
}

export type BrowserWatchPoll = BrowserCapture | {
  readonly status: 'invalid_request'
  readonly reason: 'job_not_found' | 'watch_job_url_missing' | 'unsupported_job_url' | 'external_job_id_mismatch'
  readonly targetCount: 0
}

export interface BossWatchBrowserController {
  status(): Promise<BrowserStatus>
  captureCurrentJob(): Promise<BrowserCapture>
  captureCurrentConversation?(applicationId: string): Promise<BrowserConversationCapture>
  discoverJobs(): Promise<BrowserJobDiscovery>
  captureDiscoveredJob(discoveryId: string, externalJobId: string): Promise<BrowserDiscoveredCapture>
  pollJob(applicationId: string): Promise<BrowserWatchPoll>
  inspectApplicationForm(expectedUrl: string): Promise<BrowserApplicationFormInspection>
}
