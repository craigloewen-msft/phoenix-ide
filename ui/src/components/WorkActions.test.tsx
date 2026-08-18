
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { WorkControlBar } from './WorkActions';
import { StateBar } from './StateBar';
import { api, type AssociatedPrStatusEnvelope, type PrStatusResponse } from '../api';
import { ViewerSlotProvider, useViewerSlot } from '../contexts/ViewerSlotContext';

// WorkControlBar reads the unified viewer slot; MemoryRouter backs the slot's
// URL contract.
const renderWithProviders = (ui: ReactElement) =>
  render(
    <MemoryRouter>
      <ViewerSlotProvider browserSessionActive={false}>
        {ui}
      </ViewerSlotProvider>
    </MemoryRouter>,
  );

function CaptureSlot({ onSlot }: { onSlot: (slot: ReturnType<typeof useViewerSlot>['slot']) => void }) {
  const { slot } = useViewerSlot();
  useEffect(() => { onSlot(slot); }, [slot, onSlot]);
  return null;
}

vi.mock('../api', () => ({
  api: {
    abandonTask: vi.fn().mockResolvedValue({ success: true }),
    markMerged: vi.fn().mockResolvedValue({ success: true }),
    mergeToLocalBase: vi.fn().mockResolvedValue({ success: true }),
    archiveConversation: vi.fn().mockResolvedValue({ ok: true }),
    getConversationDiff: vi.fn(),
    getPrStatus: vi.fn(),
    createPrAutoFixContext: vi
      .fn()
      .mockResolvedValue({ message: 'Address `.phoenix/pr-context/pr-12.json`' }),
  },
}));

function cleanWorkChange(): PrStatusResponse['work_change'] {
  return { kind: 'clean' };
}

function selection(overrides: Partial<AssociatedPrStatusEnvelope> = {}): AssociatedPrStatusEnvelope {
  return {
    associated_prs: [
      {
        repo_owner: 'o',
        repo_name: 'r',
        pr_number: 12,
        title: 'Fix CI',
        url: 'https://github.com/o/r/pull/12',
        state: 'OPEN',
        draft: false,
        display_state: 'open',
        base: 'main',
        head: 'task-123',
        feedback_status: 'open',
      },
    ],
    active_pr: { pr: { repo_owner: 'o', repo_name: 'r', pr_number: 12 }, provenance: 'inferred' },
    ...overrides,
  };
}

function prStatusHandle(prStatus: Partial<PrStatusResponse> = { found: false }, overrides: Record<string, unknown> = {}) {
  const status: PrStatusResponse = {
    found: false,
    refresh: {
      state: 'not_found',
      last_attempted_at: '2026-01-01T00:00:00Z',
      last_refreshed_at: '2026-01-01T00:00:00Z',
      stale: false,
    },
    work_change: cleanWorkChange(),
    ...prStatus,
  };
  const selectionValue = (status.selection ?? selection()) as NonNullable<PrStatusResponse['selection']>;
  const committedStatus = selectionValue ? { ...status, selection: selectionValue } : status;
  const associated = selectionValue?.associated_prs ?? [];
  return {
    state: { status: 'ready' as const, prStatus: committedStatus },
    refresh: vi.fn().mockResolvedValue(committedStatus),
    refreshForSafety: vi.fn().mockResolvedValue(committedStatus),
    refreshAfterMutation: vi.fn().mockResolvedValue(committedStatus),
    activeSelection: selectionValue,
    activePrSummary: selectionValue?.active_pr
      ? associated.find((pr) => pr.repo_owner === selectionValue.active_pr?.pr.repo_owner
        && pr.repo_name === selectionValue.active_pr?.pr.repo_name
        && pr.pr_number === selectionValue.active_pr?.pr.pr_number) ?? null
      : null,
    ambiguous: !!selectionValue && !selectionValue.active_pr && associated.filter((pr) => pr.display_state === 'open' || pr.display_state === 'draft').length > 1,
    pinActivePr: vi.fn().mockResolvedValue(undefined),
    resumeInference: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Count of glowing primaries across the whole bar — must always be exactly 1
 *  when the bar is in a dispositive (non-continued) state. */
function primaryCount() {
  return document.querySelectorAll('.work-actions-btn--primary').length;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getPrStatus).mockResolvedValue({
    found: false,
    refresh: { state: 'fresh', stale: false, last_attempted_at: '', last_refreshed_at: '' },
    associated_prs: [],
    work_change: cleanWorkChange(),
  });
});

describe('WorkControlBar — visibility (REQ-WAB-001)', () => {
  it('is hidden in a non-Work/Branch mode (Direct)', () => {
    renderWithProviders(
      <WorkControlBar
        conversationId="conv-1"
        convModeLabel="Direct"
        phaseType="idle"
        continuedInConvId={null}
        baseBranch="main"
        prStatusHandle={prStatusHandle()}
      />,
    );
    expect(screen.queryByTestId('view-diff-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('abandon-button')).not.toBeInTheDocument();
  });


  it('is hidden for a context_exhausted phase on Work', () => {
    renderWithProviders(
      <WorkControlBar
        conversationId="conv-1"
        convModeLabel="Work"
        phaseType="context_exhausted"
        continuedInConvId={null}
        baseBranch="main"
        prStatusHandle={prStatusHandle()}
      />,
    );
    expect(screen.queryByTestId('abandon-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('view-diff-button')).not.toBeInTheDocument();
  });
});

describe('WorkControlBar — continuation gate (REQ-WAB-009)', () => {
  it('hides both terminal verbs, shows only the continuation note, glows nothing', () => {
    renderWithProviders(
      <WorkControlBar
        conversationId="conv-1"
        convModeLabel="Work"
        phaseType="idle"
        continuedInConvId="continuation-id"
        baseBranch="main"
        prStatusHandle={prStatusHandle()}
      />,
    );

    // FINISH zone fully suppressed — no dead disabled button (REQ-WAB-008/009).
    expect(screen.queryByTestId('abandon-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('clean-up-button')).not.toBeInTheDocument();

    expect(
      document.querySelector('.work-actions-continuation-note'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Continued — actions belong on the continuation/i),
    ).toBeInTheDocument();

    // No primary glow in the continued case.
    expect(primaryCount()).toBe(0);
  });
});

describe('WorkControlBar — stuck phases suppress RESOLVE (REQ-WAB-005)', () => {
  it.each(['error'] as const)(
    'exposes Clean up + Abandon but NO address-feedback even with an open PR (%s)',
    (phaseType) => {
      renderWithProviders(
        <WorkControlBar
          conversationId="conv-1"
          convModeLabel="Work"
          phaseType={phaseType}
          continuedInConvId={null}
          baseBranch="main"
          onSendMessage={vi.fn()}
          prStatusHandle={prStatusHandle({
            found: true,
            number: 12,
            url: 'https://gh/pr/12',
            display_state: 'open',
            check_state: 'failing',
          })}
        />,
      );

      // Stuck + open PR → primary collapses to Abandon (an open PR can't be
      // cleaned up), RESOLVE is suppressed.
      expect(screen.getByTestId('abandon-button')).toBeInTheDocument();
      expect(screen.queryByTestId('address-feedback-button')).not.toBeInTheDocument();
      expect(screen.queryByTestId('merge-pr-link')).not.toBeInTheDocument();
    },
  );
});

describe('WorkControlBar — idle disposition cases (REQ-WAB-004)', () => {


  it('refreshes status after feedback capture with post-mutation ordering', async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined);
    const handle = prStatusHandle({
      found: true,
      number: 12,
      url: 'https://gh/pr/12',
      display_state: 'open',
      check_state: 'failing',
    });

    renderWithProviders(
      <WorkControlBar
        conversationId="conv-capture"
        convModeLabel="Work"
        phaseType="idle"
        continuedInConvId={null}
        baseBranch="main"
        onSendMessage={onSendMessage}
        prStatusHandle={handle}
      />,
    );

    fireEvent.click(screen.getByTestId('address-feedback-button'));

    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('Address `.phoenix/pr-context/pr-12.json`'));
    await waitFor(() => expect(handle.refreshAfterMutation).toHaveBeenCalledTimes(1));
    expect(handle.refresh).not.toHaveBeenCalled();
  });



  it('no PR + dirty PR-ready work → Create PR external link is primary and Clean up hidden', () => {
    const createUrl = 'https://github.com/o/r/compare/main...task-1?expand=1';
    renderWithProviders(
      <WorkControlBar
        conversationId="conv-none"
        convModeLabel="Work"
        phaseType="idle"
        continuedInConvId={null}
        baseBranch="main"
        prStatusHandle={prStatusHandle({
          found: false,
          work_change: {
            kind: 'dirty_pr_ready',
            create_pr_url: createUrl,
            branch_name: 'task-1',
            base_branch: 'main',
          },
        })}
      />,
    );

    const link = screen.getByTestId('create-pr-link') as HTMLAnchorElement;
    expect(link).toHaveClass('work-actions-btn--primary');
    expect(link).toHaveAttribute('href', createUrl);
    expect(link.textContent).toMatch(/Create PR on GitHub ↗/);
    expect(screen.queryByTestId('clean-up-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('abandon-button')).toBeInTheDocument();
    expect(primaryCount()).toBe(1);
  });
});

describe('WorkControlBar — terminal cleanup actions', () => {
  it('Clean up is a single click that calls api.markMerged (no two-step)', async () => {
    renderWithProviders(
      <WorkControlBar
        conversationId="conv-1"
        convModeLabel="Work"
        phaseType="idle"
        continuedInConvId={null}
        baseBranch="main"
        prStatusHandle={prStatusHandle({ found: false })}
      />,
    );
    fireEvent.click(screen.getByTestId('clean-up-button'));
    await waitFor(() => expect(api.markMerged).toHaveBeenCalledTimes(1));
    expect(api.markMerged).toHaveBeenCalledWith('conv-1');
  });

  it('Merge to base merges, archives, and leaves the conversation', async () => {
    renderWithProviders(
      <WorkControlBar
        conversationId="conv-1"
        convModeLabel="Work"
        phaseType="idle"
        continuedInConvId={null}
        baseBranch="main"
        prStatusHandle={prStatusHandle({ found: false })}
      />,
    );
    const button = screen.getByTestId('merge-to-local-base-button');
    expect(button.textContent).toBe('Merge to main');
    fireEvent.click(button);
    await waitFor(() => expect(api.mergeToLocalBase).toHaveBeenCalledWith('conv-1'));
    await waitFor(() => expect(api.archiveConversation).toHaveBeenCalledWith('conv-1'));
  });

  it('a merge conflict surfaces git\u2019s reason and does NOT archive', async () => {
    vi.mocked(api.mergeToLocalBase).mockRejectedValueOnce(
      new Error('Merge conflict merging task-1; nothing was changed.\nCONFLICT (content): shared.txt'),
    );
    renderWithProviders(
      <WorkControlBar
        conversationId="conv-1"
        convModeLabel="Work"
        phaseType="idle"
        continuedInConvId={null}
        baseBranch="main"
        prStatusHandle={prStatusHandle({ found: false })}
      />,
    );
    fireEvent.click(screen.getByTestId('merge-to-local-base-button'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/CONFLICT \(content\): shared\.txt/));
    expect(api.archiveConversation).not.toHaveBeenCalled();
  });

  it('Abandon confirms then calls api.abandonTask', async () => {
    const confirmSpy = vi.fn().mockReturnValue(true);
    const prevConfirm = window.confirm;
    window.confirm = confirmSpy;
    try {
      renderWithProviders(
        <WorkControlBar
          conversationId="conv-1"
          convModeLabel="Work"
          phaseType="idle"
          continuedInConvId={null}
          baseBranch="main"
          prStatusHandle={prStatusHandle({ found: false })}
        />,
      );
      fireEvent.click(screen.getByTestId('abandon-button'));
      expect(confirmSpy).toHaveBeenCalled();
      await waitFor(() => expect(api.abandonTask).toHaveBeenCalledWith('conv-1'));
    } finally {
      window.confirm = prevConfirm;
    }
  });

  it('Abandon does NOT call api.abandonTask when the confirm is declined', () => {
    const confirmSpy = vi.fn().mockReturnValue(false);
    const prevConfirm = window.confirm;
    window.confirm = confirmSpy;
    try {
      renderWithProviders(
        <WorkControlBar
          conversationId="conv-1"
          convModeLabel="Work"
          phaseType="idle"
          continuedInConvId={null}
          baseBranch="main"
          prStatusHandle={prStatusHandle({ found: false })}
        />,
      );
      fireEvent.click(screen.getByTestId('abandon-button'));
      expect(confirmSpy).toHaveBeenCalled();
      expect(api.abandonTask).not.toHaveBeenCalled();
    } finally {
      window.confirm = prevConfirm;
    }
  });
});

describe('WorkControlBar — View Diff (View Browser gone)', () => {
  it('View Browser is gone; View Diff opens the fullscreen diff slot', () => {
    let slot: ReturnType<typeof useViewerSlot>['slot'] = { kind: 'none' };
    renderWithProviders(
      <>
        <WorkControlBar
          conversationId="conv-1"
          convModeLabel="Branch"
          phaseType="idle"
          continuedInConvId={null}
          baseBranch="main"
          prStatusHandle={prStatusHandle()}
        />
        <CaptureSlot onSlot={(s) => { slot = s; }} />
      </>,
    );

    expect(screen.queryByTestId('view-browser-button')).toBeNull();

    expect(slot).toEqual({ kind: 'none' });
    fireEvent.click(screen.getByTestId('view-diff-button'));
    expect(slot).toEqual({ kind: 'diff', presentation: 'fullscreen', target: 'workspace' });
    expect(api.getConversationDiff).not.toHaveBeenCalled();
  });
});

describe('WorkControlBar — active PR interactions', () => {
  it('resolves desktop ambiguity directly through the persistent PR rail', async () => {
    const handle = prStatusHandle(
      { found: false },
      {
        activeSelection: selection({
          associated_prs: [
            { repo_owner: 'o', repo_name: 'r', pr_number: 12, title: 'Fix CI', url: 'https://github.com/o/r/pull/12', state: 'OPEN', draft: false, display_state: 'open', base: 'main', head: 'task-123', feedback_status: 'open' },
            { repo_owner: 'o', repo_name: 'r', pr_number: 34, title: 'Follow-up', url: 'https://github.com/o/r/pull/34', state: 'OPEN', draft: false, display_state: 'open', base: 'task-123', head: 'task-123-follow-up', feedback_status: 'open' },
          ],
        }),
        activePrSummary: null,
        ambiguous: true,
      },
    );
    delete handle.activeSelection.active_pr;

    renderWithProviders(
      <>
        <StateBar
          conversation={{
            id: 'conv-1', slug: 'slug', model: 'claude-sonnet-5', cwd: '/repo/.phoenix/worktrees/conv-1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', message_count: 1, state: { type: 'idle' }, branch_name: 'task-123', base_branch: 'main', worktree_path: '/repo/.phoenix/worktrees/conv-1', task_title: 'Task', conv_mode_label: 'Work', browser_session_active: false, terminal_uses_tmux: false, work_scope_key: 'worktree:/repo/.phoenix/worktrees/conv-1',
          }}
          convState={{ type: 'idle' }}
          connectionState="connected"
          connectionAttempt={0}
          nextRetryIn={null}
          contextWindowUsed={0}
          modelContextWindow={200_000}
          prStatusHandle={handle}
        />
        <WorkControlBar
          conversationId="conv-1"
          convModeLabel="Work"
          phaseType="idle"
          continuedInConvId={null}
          baseBranch="main"
          onSendMessage={vi.fn()}
          prStatusHandle={handle}
        />
      </>,
    );

    expect(screen.queryByTestId('active-pr-selector-trigger')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /#12 Fix CI open task-123/ }));
    await waitFor(() => expect(handle.pinActivePr).toHaveBeenCalledWith({ repo_owner: 'o', repo_name: 'r', pr_number: 12 }));
  });

  it('commits a newly ambiguous safety refresh before opening the selector', async () => {
    const latest = {
      found: false,
      refresh: { state: 'fresh' as const, stale: false, last_attempted_at: '', last_refreshed_at: '' },
      work_change: cleanWorkChange(),
      associated_prs: [
        { repo_owner: 'o', repo_name: 'r', pr_number: 12, title: 'Fix CI', url: 'https://gh/pr/12', state: 'OPEN', draft: false, display_state: 'open' as const, base: 'main', head: 'task-123', feedback_status: 'open' as const },
        { repo_owner: 'o', repo_name: 'r', pr_number: 34, title: 'Follow-up', url: 'https://gh/pr/34', state: 'OPEN', draft: false, display_state: 'open' as const, base: 'task-123', head: 'follow-up', feedback_status: 'open' as const },
      ],
    };
    const handle = prStatusHandle({ found: false }, {
      refreshForSafety: vi.fn().mockResolvedValue(latest),
    });

    renderWithProviders(
      <WorkControlBar
        conversationId="conv-1"
        convModeLabel="Work"
        phaseType="idle"
        continuedInConvId={null}
        baseBranch="main"
        prStatusHandle={handle}
      />,
    );

    fireEvent.click(screen.getByTestId('clean-up-button'));

    await waitFor(() => expect(handle.refreshForSafety).toHaveBeenCalledTimes(1));
    expect(api.markMerged).not.toHaveBeenCalled();
    expect(screen.getAllByLabelText(/Mark as merged\. Deletes the worktree/)).toHaveLength(2);
    // One hint per FINISH verb: Clean up, Merge to base, Abandon.
    expect(screen.getAllByText('ⓘ')).toHaveLength(3);
    expect(screen.getByText('Select an active PR before cleaning up or abandoning this task.')).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert.closest('.desktop-work-actions-rail')).toBeNull();
    expect(alert.closest('.desktop-work-actions-compact')).toBeInTheDocument();
  });


  it('suppresses terminal cleanup while multiple actionable associated PRs are ambiguous', () => {
    const ambiguousHandle = prStatusHandle({
      found: false,
      work_change: { kind: 'clean' },
    }, {
      activeSelection: selection({
        associated_prs: [
          { repo_owner: 'o', repo_name: 'r', pr_number: 12, title: 'Fix CI', url: 'https://gh/pr/12', state: 'OPEN', draft: false, display_state: 'open', base: 'main', head: 'task-123', feedback_status: 'open' },
          { repo_owner: 'o', repo_name: 'r', pr_number: 34, title: 'Follow-up', url: 'https://gh/pr/34', state: 'OPEN', draft: false, display_state: 'open', base: 'task-123', head: 'task-123-follow-up', feedback_status: 'open' },
          { repo_owner: 'o', repo_name: 'r', pr_number: 55, title: 'Closed', url: 'https://gh/pr/55', state: 'CLOSED', draft: false, display_state: 'closed', base: 'main', head: 'old-branch', feedback_status: 'open' },
        ],
      }),
      activePrSummary: null,
      ambiguous: true,
    });
    delete ambiguousHandle.activeSelection.active_pr;

    renderWithProviders(
      <WorkControlBar
        conversationId="conv-1"
        convModeLabel="Work"
        phaseType="idle"
        continuedInConvId={null}
        baseBranch="main"
        prStatusHandle={ambiguousHandle}
      />,
    );

    expect(screen.getByTestId('desktop-work-controls')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /#12 Fix CI open task-123/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /#34 Follow-up open task-123-follow-up/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Clean up/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Abandon/ })).not.toBeInTheDocument();
  });


  it('gates PR-specific resolve link-outs when the active selection is ambiguous', () => {
    const ambiguousHandle = prStatusHandle({
      found: true,
      number: 12,
      url: 'https://gh/pr/12',
      display_state: 'open',
      check_state: 'passing',
      selection: selection({
        associated_prs: [
          { repo_owner: 'o', repo_name: 'r', pr_number: 12, title: 'Fix CI', url: 'https://gh/pr/12', state: 'OPEN', draft: false, display_state: 'open', base: 'main', head: 'task-123', feedback_status: 'open' },
          { repo_owner: 'o', repo_name: 'r', pr_number: 34, title: 'Follow-up', url: 'https://gh/pr/34', state: 'OPEN', draft: false, display_state: 'open', base: 'task-123', head: 'task-123-follow-up', feedback_status: 'open' },
        ],
      }),
    }, {
      activeSelection: selection({
        associated_prs: [
          { repo_owner: 'o', repo_name: 'r', pr_number: 12, title: 'Fix CI', url: 'https://gh/pr/12', state: 'OPEN', draft: false, display_state: 'open', base: 'main', head: 'task-123', feedback_status: 'open' },
          { repo_owner: 'o', repo_name: 'r', pr_number: 34, title: 'Follow-up', url: 'https://gh/pr/34', state: 'OPEN', draft: false, display_state: 'open', base: 'task-123', head: 'task-123-follow-up', feedback_status: 'open' },
        ],
      }),
      activePrSummary: null,
      ambiguous: true,
    });
    delete ambiguousHandle.activeSelection.active_pr;

    renderWithProviders(
      <WorkControlBar conversationId="conv-1" convModeLabel="Work" phaseType="idle" continuedInConvId={null} baseBranch="main" onSendMessage={vi.fn()} prStatusHandle={ambiguousHandle} />,
    );

    expect(screen.queryByTestId('address-feedback-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('merge-pr-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('open-pr-link')).not.toBeInTheDocument();
    expect(screen.getByTestId('desktop-work-controls')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-pr-actions')).not.toBeInTheDocument();
  });

  it('gates active PR diff behind ambiguity and otherwise uses PR-specific comparator context', () => {
    const ambiguousHandle = prStatusHandle({ found: false }, {
      activeSelection: selection({ associated_prs: [
        { repo_owner: 'o', repo_name: 'r', pr_number: 12, title: 'Fix CI', url: 'https://github.com/o/r/pull/12', state: 'OPEN', draft: false, display_state: 'open', base: 'main', head: 'task-123', feedback_status: 'open' },
        { repo_owner: 'o', repo_name: 'r', pr_number: 34, title: 'Follow-up', url: 'https://github.com/o/r/pull/34', state: 'OPEN', draft: false, display_state: 'open', base: 'task-123', head: 'task-123-follow-up', feedback_status: 'open' },
      ] }),
      activePrSummary: null,
      ambiguous: true,
    });
    delete ambiguousHandle.activeSelection.active_pr;
    const { rerender } = renderWithProviders(
      <WorkControlBar conversationId="conv-1" convModeLabel="Work" phaseType="idle" continuedInConvId={null} baseBranch="main" onSendMessage={vi.fn()} prStatusHandle={ambiguousHandle} />,
    );
    expect(screen.queryByTestId('view-active-pr-diff-button')).not.toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <ViewerSlotProvider browserSessionActive={false}>
          <WorkControlBar conversationId="conv-1" convModeLabel="Work" phaseType="idle" continuedInConvId={null} baseBranch="main" onSendMessage={vi.fn()} prStatusHandle={prStatusHandle({ found: true, number: 12, url: 'https://gh/pr/12', display_state: 'open', check_state: 'failing' })} />
        </ViewerSlotProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('view-active-pr-diff-button')).toHaveAttribute('aria-label', 'View PR #12 diff compared with its base branch');
  });
});


describe('WorkControlBar — PR feedback freshness + coverage (#288)', () => {
  it('shows a "N new" freshness marker inside the address-feedback button', () => {
    renderWithProviders(
      <WorkControlBar
        conversationId="conv-freshness"
        convModeLabel="Work"
        phaseType="idle"
        continuedInConvId={null}
        baseBranch="main"
        onSendMessage={vi.fn()}
        prStatusHandle={prStatusHandle({
          found: true,
          number: 137,
          url: 'https://gh/pr/137',
          display_state: 'open',
          feedback_freshness: { state: 'new', count: 3 },
        })}
      />,
    );

    const button = screen.getByTestId('address-feedback-button');
    const freshness = button.querySelector('.work-actions-pr-freshness');
    expect(freshness).toBeInTheDocument();
    expect(freshness?.textContent).toBe('3 new');
  });


  it('renders the count as a lower bound and a ⚠ warning when feedback coverage is degraded', () => {
    renderWithProviders(
      <WorkControlBar
        conversationId="conv-incomplete"
        convModeLabel="Work"
        phaseType="idle"
        continuedInConvId={null}
        baseBranch="main"
        onSendMessage={vi.fn()}
        prStatusHandle={prStatusHandle({
          found: true,
          number: 140,
          url: 'https://gh/pr/140',
          display_state: 'open',
          feedback_freshness: { state: 'new', count: 2 },
          feedback_coverage: { kind: 'incomplete', surfaces: ['review_threads'] },
        })}
      />,
    );

    const button = screen.getByTestId('address-feedback-button');
    // Lower-bound prefix from the degraded coverage.
    expect(button.querySelector('.work-actions-pr-freshness')?.textContent).toBe(
      'at least 2 new',
    );
    // Transient (non-actionable) coverage gap → icon-only ⚠, no --auth class.
    const coverage = button.querySelector('.work-actions-pr-coverage');
    expect(coverage).toBeInTheDocument();
    expect(coverage).not.toHaveClass('work-actions-pr-coverage--auth');
    expect(coverage?.textContent).toContain('⚠');
    expect(coverage).toHaveAttribute('title', expect.stringContaining('review threads'));
  });

  it('rides the coverage marker on the Address-feedback primary when a passing PR has a coverage gap', () => {
    renderWithProviders(
      <WorkControlBar
        conversationId="conv-merge-cov"
        convModeLabel="Work"
        phaseType="idle"
        continuedInConvId={null}
        baseBranch="main"
        onSendMessage={vi.fn()}
        prStatusHandle={prStatusHandle({
          found: true,
          number: 142,
          url: 'https://gh/pr/142',
          display_state: 'open',
          check_state: 'passing',
          feedback_coverage: { kind: 'auth_required', surfaces: ['review_threads'] },
        })}
      />,
    );

    // Address feedback is the primary (open + can send); Merge rides as the
    // secondary link. The coverage marker rides on the primary verb only, never
    // duplicated onto the secondary link.
    const address = screen.getByTestId('address-feedback-button');
    const merge = screen.getByTestId('merge-pr-link');
    const coverage = address.querySelector('.work-actions-pr-coverage');
    expect(coverage).toBeInTheDocument();
    expect(coverage).toHaveClass('work-actions-pr-coverage--auth');
    expect(coverage?.textContent).toContain('GitHub sign-in needed');
    expect(merge.querySelector('.work-actions-pr-coverage')).toBeNull();
  });

  it('shows an actionable "GitHub sign-in needed" auth marker when feedback auth failed', () => {
    renderWithProviders(
      <WorkControlBar
        conversationId="conv-auth"
        convModeLabel="Work"
        phaseType="idle"
        continuedInConvId={null}
        baseBranch="main"
        onSendMessage={vi.fn()}
        prStatusHandle={prStatusHandle({
          found: true,
          number: 141,
          url: 'https://gh/pr/141',
          display_state: 'open',
          check_state: 'failing',
          feedback_coverage: { kind: 'auth_required', surfaces: ['review_threads'] },
        })}
      />,
    );

    const button = screen.getByTestId('address-feedback-button');
    const coverage = button.querySelector('.work-actions-pr-coverage');
    expect(coverage).toBeInTheDocument();
    expect(coverage).toHaveClass('work-actions-pr-coverage--auth');
    expect(coverage?.textContent).toContain('⚠ GitHub sign-in needed');
  });

  it('keeps remediation loading until send completes and then refreshes PR status', async () => {
    let resolveSend!: () => void;
    const sendPromise = new Promise<void>((resolve) => { resolveSend = resolve; });
    const onSendMessage = vi.fn(() => sendPromise);
    const handle = prStatusHandle({
      found: true,
      number: 139,
      url: 'https://gh/pr/139',
      display_state: 'open',
      feedback_freshness: { state: 'new', count: 2 },
      selection: selection({
        associated_prs: [{ repo_owner: 'o', repo_name: 'r', pr_number: 139, title: 'Fix CI', url: 'https://gh/pr/139', state: 'OPEN', draft: false, display_state: 'open' as const, base: 'main', head: 'task-123', feedback_status: 'open' }],
        active_pr: { pr: { repo_owner: 'o', repo_name: 'r', pr_number: 139 }, provenance: 'inferred' },
      }),
    });

    renderWithProviders(
      <WorkControlBar
        conversationId="conv-remediate"
        convModeLabel="Work"
        phaseType="idle"
        continuedInConvId={null}
        baseBranch="main"
        onSendMessage={onSendMessage}
        prStatusHandle={handle}
      />,
    );

    const button = screen.getByTestId('address-feedback-button');
    fireEvent.click(button);

    // createPrAutoFixContext → onSendMessage with the captured message.
    await waitFor(() => {
      expect(api.createPrAutoFixContext).toHaveBeenCalledWith('conv-remediate');
      expect(onSendMessage).toHaveBeenCalledWith('Address `.phoenix/pr-context/pr-12.json`');
    });

    // Loading state holds while send is in flight; refresh not yet called.
    expect(button.textContent).toMatch(/Capturing/i);
    // Button is disabled while capturing — no double-submit (codex #2).
    expect((screen.getByTestId('address-feedback-button') as HTMLButtonElement).disabled).toBe(true);
    expect(handle.refreshAfterMutation).not.toHaveBeenCalled();

    resolveSend();

    // Once send completes, PR status refreshes and the label settles back.
    await waitFor(() => {
      expect(handle.refreshAfterMutation).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId('address-feedback-button').textContent).toMatch(
        /Address PR #139 feedback/i,
      );
    });
  });
});

describe('WorkControlBar — desktop multi-PR rail', () => {

  it('shows each desktop PR feedback status without requiring selection', () => {
    const handle = prStatusHandle({
      found: true,
      number: 12,
      url: 'https://github.com/o/r/pull/12',
      display_state: 'open',
      feedback_status: 'approved',
      selection: {
        ...selection(),
        associated_prs: [
          { ...selection().associated_prs[0]!, feedback_status: 'approved' },
          { ...selection().associated_prs[0]!, pr_number: 13, title: 'Needs review', url: 'https://github.com/o/r/pull/13', head: 'task-124', feedback_status: 'open' },
          { ...selection().associated_prs[0]!, pr_number: 14, title: 'Being handled', url: 'https://github.com/o/r/pull/14', head: 'task-125', feedback_status: 'in_progress' },
        ],
      },
    });
    renderWithProviders(
      <WorkControlBar conversationId="conv-desktop-feedback" convModeLabel="Work" phaseType="idle" continuedInConvId={null} baseBranch="main" onSendMessage={vi.fn()} prStatusHandle={handle} />,
    );

    expect(screen.getByRole('button', { name: /#13 Needs review open task-124$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /#14 Being handled open task-125 feedback in progress \(eyes reaction\)/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /#12 Fix CI open task-123 feedback approved \(thumbs-up reaction\)/ })).toBeInTheDocument();
    expect(screen.getByText('👀').parentElement).toHaveAttribute('title', 'feedback in progress (eyes reaction)');
    expect(screen.getByText('👍').parentElement).toHaveAttribute('title', 'feedback approved (thumbs-up reaction)');
  });


  it('uses the active summary for compact chip state and review status', () => {
    const handle = prStatusHandle({
      found: true,
      number: 12,
      display_state: 'open',
      feedback_status: 'open',
      selection: {
        ...selection(),
        associated_prs: [
          { ...selection().associated_prs[0]!, display_state: 'draft', feedback_status: 'approved' },
        ],
      },
    });
    renderWithProviders(
      <WorkControlBar conversationId="conv-desktop-summary-authority" convModeLabel="Work" phaseType="idle" continuedInConvId={null} baseBranch="main" onSendMessage={vi.fn()} prStatusHandle={handle} />,
    );

    expect(screen.getByTestId('desktop-work-actions-identity')).toHaveTextContent('#12draft👍');
    expect(screen.getByRole('button', { name: '#12 draft feedback approved (thumbs-up reaction)' })).toBeInTheDocument();
  });

});

describe('WorkControlBar — mobile PR rail (REQ-WAB-011)', () => {
  const enableMobile = () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === '(max-width: 768px)',
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  };

  const twoOpenPrSelection = (active = true): AssociatedPrStatusEnvelope => ({
    associated_prs: [
      ...selection().associated_prs,
      { ...selection().associated_prs[0]!, pr_number: 13, title: 'Second PR', url: 'https://github.com/o/r/pull/13', head: 'task-124' },
    ],
    ...(active ? { active_pr: selection().active_pr } : {}),
  });

  it('shows a thin rail of open PRs and expands the selected PR actions upward', () => {
    enableMobile();
    const handle = prStatusHandle({
      found: true,
      number: 12,
      url: 'https://github.com/o/r/pull/12',
      display_state: 'open',
      check_state: 'failing',
      feedback_freshness: { state: 'new', count: 3 },
      feedback_status: 'open',
      selection: twoOpenPrSelection(),
    });
    renderWithProviders(
      <WorkControlBar conversationId="conv-mobile" convModeLabel="Work" phaseType="idle" continuedInConvId={null} baseBranch="main" onSendMessage={vi.fn()} prStatusHandle={handle} />,
    );

    expect(screen.getByLabelText('Open pull requests')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /#12 open 3 new feedback/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /#13 open/ })).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-pr-actions')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /#12 open 3 new feedback/ }));
    expect(screen.getByTestId('mobile-pr-actions')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-primary-address-feedback')).toHaveTextContent('Address feedback · 3 new');
    expect(screen.getByRole('button', { name: 'PR #12 diff' })).toHaveTextContent('PR diff');
    expect(screen.getByRole('button', { name: 'Workspace diff' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clean up' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Abandon\./ })).toHaveClass('mobile-pr-action--danger');
  });


  it('uses lifecycle fallback when the active PR is terminal but another PR is open', () => {
    enableMobile();
    const mixedSelection = selection({
      associated_prs: [
        { ...selection().associated_prs[0]!, state: 'CLOSED', display_state: 'merged' },
        { ...selection().associated_prs[0]!, pr_number: 13, title: 'Still open', url: 'https://github.com/o/r/pull/13', head: 'task-124' },
      ],
    });
    const handle = prStatusHandle({ found: true, number: 12, display_state: 'merged', selection: mixedSelection });
    renderWithProviders(
      <WorkControlBar conversationId="conv-mobile-terminal-active" convModeLabel="Work" phaseType="idle" continuedInConvId={null} baseBranch="main" prStatusHandle={handle} />,
    );

    expect(screen.getByTestId('mobile-work-fallback')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Clean up\./ })).toHaveAttribute('title', expect.stringContaining('No confirmation'));
    expect(screen.queryByLabelText('Open pull requests')).not.toBeInTheDocument();
  });


  it('keeps Address feedback for a cached PR before associations load', () => {
    enableMobile();
    const handle = prStatusHandle(
      { found: true, number: 12, url: 'https://github.com/o/r/pull/12', display_state: 'open', check_state: 'failing', feedback_status: 'open' },
      { activeSelection: null, activePrSummary: null, ambiguous: false },
    );
    renderWithProviders(
      <WorkControlBar conversationId="conv-mobile-cached" convModeLabel="Work" phaseType="idle" continuedInConvId={null} baseBranch="main" onSendMessage={vi.fn()} prStatusHandle={handle} />,
    );

    expect(screen.getByTestId('mobile-work-fallback')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-primary-address-feedback')).toHaveTextContent('Address feedback');
  });


  it('lets a pinned mobile selection resume automatic inference', async () => {
    enableMobile();
    const resumeInference = vi.fn().mockResolvedValue(undefined);
    const pinnedSelection = twoOpenPrSelection();
    pinnedSelection.active_pr = { ...pinnedSelection.active_pr!, provenance: 'pinned' };
    const handle = prStatusHandle({
      found: true,
      number: 12,
      url: 'https://github.com/o/r/pull/12',
      display_state: 'open',
      check_state: 'failing',
      feedback_status: 'open',
      selection: pinnedSelection,
    }, { resumeInference });
    renderWithProviders(
      <WorkControlBar conversationId="conv-mobile-pinned" convModeLabel="Work" phaseType="idle" continuedInConvId={null} baseBranch="main" onSendMessage={vi.fn()} prStatusHandle={handle} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /#12 open/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    await waitFor(() => expect(resumeInference).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('mobile-pr-actions')).not.toBeInTheDocument();
  });

  it('pins a different open PR through the shared handle', async () => {
    enableMobile();
    const pinActivePr = vi.fn().mockResolvedValue(undefined);
    const handle = prStatusHandle({ found: false, selection: twoOpenPrSelection(false) }, { pinActivePr });
    renderWithProviders(
      <WorkControlBar conversationId="conv-mobile-select" convModeLabel="Work" phaseType="idle" continuedInConvId={null} baseBranch="main" prStatusHandle={handle} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /#13 open/ }));
    await waitFor(() => expect(pinActivePr).toHaveBeenCalledWith({ repo_owner: 'o', repo_name: 'r', pr_number: 13 }));
  });

  it('reports a failed active-PR mutation without inventing a selection', async () => {
    enableMobile();
    const pinActivePr = vi.fn().mockRejectedValue(new Error('Could not save selection'));
    const handle = prStatusHandle({ found: false, selection: twoOpenPrSelection(false) }, { pinActivePr });
    renderWithProviders(
      <WorkControlBar conversationId="conv-mobile-error" convModeLabel="Work" phaseType="idle" continuedInConvId={null} baseBranch="main" prStatusHandle={handle} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /#13 open/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save selection');
    expect(screen.queryByTestId('mobile-pr-actions')).not.toBeInTheDocument();
  });
});
