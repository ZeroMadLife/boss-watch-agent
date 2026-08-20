import { useEffect, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconDataOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  DASHBOARD_DRAFT_EVENT,
  isDashboardDraftRequest,
  mergeDashboardDraft,
} from './dashboard-client.ts'
import { NS } from './locales.ts'
import css from './JobSearchDashboardButton.module.css'

export const DASHBOARD_TOGGLE_EVENT = 'boss-watch:dashboard-toggle'
export const DASHBOARD_TRIGGER_ID = 'boss-watch-dashboard-trigger'

export type JobSearchDashboardButtonProps =
  PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<typeof NS>

/** Open the full same-origin workbench without crowding the DSH conversation. */
export function JobSearchDashboardButton({ t, useInput, inputActions }: JobSearchDashboardButtonProps): ReactNode {
  const draft = useInput(state => state.draft)

  useEffect(() => {
    const onDraft = (event: Event): void => {
      if (!(event instanceof CustomEvent) || !isDashboardDraftRequest(event.detail)) return
      inputActions.setDraft(mergeDashboardDraft(draft, event.detail.draft))
    }
    window.addEventListener(DASHBOARD_DRAFT_EVENT, onDraft)
    return () => window.removeEventListener(DASHBOARD_DRAFT_EVENT, onDraft)
  }, [draft, inputActions])

  return (
    <Tooltip label={t('dashboard.action')} side="bottom" delayMs={500}>
      <button
        type="button"
        className={css.headerButton}
        id={DASHBOARD_TRIGGER_ID}
        aria-label={t('dashboard.action')}
        onClick={() => window.dispatchEvent(new Event(DASHBOARD_TOGGLE_EVENT))}
      >
        <IconDataOutline16 size={16} />
      </button>
    </Tooltip>
  )
}
