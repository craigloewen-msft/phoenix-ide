import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { FileViewer } from './FileViewer';
import { ReviewNotesProvider } from '../contexts/ReviewNotesContext';
import { ViewerSlotProvider } from '../contexts/ViewerSlotContext';
import { ReviewProvider } from '../contexts/ReviewContext';
import { api, type ReviewManifestResponse } from '../api';
import { resetCodeViewMock } from './viewer/__testutils__/codeViewMock';
import { FileExplorerContext } from './FileExplorer/fileExplorerTypes';
import type { FileExplorerContextValue } from './FileExplorer/fileExplorerTypes';

vi.mock('@pierre/diffs/react', async () => {
  const { makeCodeViewMock } = await import('./viewer/__testutils__/codeViewMock');
  return makeCodeViewMock();
});

function renderReader(filePath: string) {
  return render(
    <ReviewNotesProvider>
      <FileViewer
        filePath={filePath}
        rootDir="/tmp/project"
        onClose={() => undefined}
        onSendNotes={() => undefined}
      />
    </ReviewNotesProvider>,
  );
}

describe('FileViewer typed file responses', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders image responses using the preview URL instead of text content', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      kind: 'image',
      mime_type: 'image/png',
      url: '/preview/tmp/project/screenshot.png',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    renderReader('screenshot.png');

    const image = await screen.findByRole('img', { name: 'screenshot.png' });
    expect(image).toHaveAttribute('src', '/preview/tmp/project/screenshot.png');
    expect(screen.queryByText(/File appears to be binary/)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/files/read?path=%2Ftmp%2Fproject%2Fscreenshot.png');
  });

  it('continues to render text responses as prose content', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      kind: 'text',
      content: 'hello text file',
      encoding: 'utf-8',
      category: 'plain',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    renderReader('notes.txt');

    expect(await screen.findByTestId('codeview-mock')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('routes very line-heavy text files through Pierre instead of the large plain-text fallback', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      kind: 'text',
      content: `${'line\n'.repeat(2_001)}tail`,
      encoding: 'utf-8',
      category: 'plain',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    renderReader('big.txt');

    expect(await screen.findByTestId('codeview-mock')).toBeInTheDocument();
    expect(screen.queryByTestId('viewer-large-text-fallback')).not.toBeInTheDocument();
  });
});

describe('FileViewer safe editing', () => {
  let context: FileExplorerContextValue;
  let transitionGuard: ((continueTransition: () => void) => boolean) | null;

  beforeEach(() => {
    transitionGuard = null;
    context = {
      openFile: vi.fn(),
      activeFile: '/tmp/project/notes.txt',
      closeFile: vi.fn(),
      openFileState: { path: '/tmp/project/notes.txt', rootDir: '/tmp/project' },
      fileMutation: null,
      notifyFileMutation: vi.fn(),
      requestFileTransition: (transition) => {
        if (!transitionGuard?.(transition)) transition();
      },
      registerFileTransitionGuard: (guard) => {
        transitionGuard = guard;
        return () => { if (transitionGuard === guard) transitionGuard = null; };
      },
    };
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderEditable(onClose = vi.fn()) {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      content: { kind: 'text', content: 'hello text file', encoding: 'utf-8', category: 'plain' },
      capability: { kind: 'mutable_text', version: 'version-one' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    render(
      <FileExplorerContext.Provider value={context}>
        <ReviewNotesProvider>
          <FileViewer
            filePath="notes.txt"
            rootDir="/tmp/project"
            conversationId="conv-1"
            onClose={onClose}
            onSendNotes={() => undefined}
          />
        </ReviewNotesProvider>
      </FileExplorerContext.Provider>,
    );
    return onClose;
  }

  it('starts disarmed and saves an explicit dirty draft against the observed version', async () => {
    renderEditable();
    expect(await screen.findByRole('button', { name: 'Edit mode: Off' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit mode: Off' }));
    const editor = screen.getByRole('textbox', { name: 'Edit notes.txt' });
    fireEvent.change(editor, { target: { value: 'updated text' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ version: 'version-two' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
    expect(fetch).toHaveBeenLastCalledWith('/api/conversations/conv-1/files/content', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ path: 'notes.txt', content: 'updated text', expected_version: 'version-one' }),
    }));
    expect(context.notifyFileMutation).toHaveBeenCalledWith({ kind: 'saved', path: '/tmp/project/notes.txt' });
  });

  it('guards dirty close and performs the held transition only after discard', async () => {
    const onClose = renderEditable();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit mode: Off' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit notes.txt' }), { target: { value: 'dirty' } });

    fireEvent.click(screen.getByRole('button', { name: 'Close viewer' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('textbox', { name: 'Edit notes.txt' })).toHaveValue('dirty');

    fireEvent.click(screen.getByRole('button', { name: 'Close viewer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('preserves the draft on conflict and reloads latest only after discard confirmation', async () => {
    renderEditable();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit mode: Off' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit notes.txt' }), { target: { value: 'my draft' } });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'File content changed since it was read', error_type: 'file_version_conflict',
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('File content changed');
    expect(screen.getByRole('textbox', { name: 'Edit notes.txt' })).toHaveValue('my draft');
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
    expect(screen.getByRole('dialog', { name: 'Discard changes and reload?' })).toBeInTheDocument();

    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      content: { kind: 'text', content: 'external content', encoding: 'utf-8', category: 'plain' },
      capability: { kind: 'mutable_text', version: 'version-external' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard and reload' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Edit notes.txt' })).toHaveValue('external content'));
    expect(screen.getByRole('button', { name: 'Edit mode: On' })).toBeInTheDocument();
  });

  it('reclassifies the viewer when reload latest changes text into an image', async () => {
    renderEditable();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit mode: Off' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit notes.txt' }), { target: { value: 'my draft' } });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'File content changed since it was read', error_type: 'file_version_conflict',
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reload latest' }));

    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      content: { kind: 'image', mime_type: 'image/png', url: '/preview/new-image.png' },
      capability: { kind: 'delete_only', version: 'image-version' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard and reload' }));

    const image = await screen.findByRole('img', { name: 'notes.txt' });
    expect(image).toHaveAttribute('src', '/preview/new-image.png');
    expect(screen.getByRole('button', { name: 'Edit mode: On' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Edit notes.txt' })).not.toBeInTheDocument();
  });

  it('blocks viewer transitions while a save is in flight', async () => {
    const onClose = renderEditable();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit mode: Off' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit notes.txt' }), { target: { value: 'saving draft' } });
    let resolveSave: ((response: Response) => void) | null = null;
    vi.mocked(fetch).mockReturnValueOnce(new Promise((resolve) => { resolveSave = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close viewer' }));
    expect(onClose).not.toHaveBeenCalled();

    resolveSave!(new Response(JSON.stringify({ version: 'version-two' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Close viewer' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('requires an armed named confirmation before deleting', async () => {
    const onClose = renderEditable();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit mode: Off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('dialog', { name: 'Delete notes.txt?' })).toHaveTextContent('cannot be undone');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete file' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenLastCalledWith('/api/conversations/conv-1/files/content', expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ path: 'notes.txt', expected_version: 'version-one' }),
    }));
  });

  it('allows an image to be armed for deletion without exposing a text editor', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      content: { kind: 'image', mime_type: 'image/png', url: '/preview/tmp/project/image.png' },
      capability: { kind: 'delete_only', version: 'image-version' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    render(
      <FileExplorerContext.Provider value={context}>
        <ReviewNotesProvider>
          <FileViewer filePath="image.png" rootDir="/tmp/project" conversationId="conv-1" onClose={() => undefined} onSendNotes={() => undefined} />
        </ReviewNotesProvider>
      </FileExplorerContext.Provider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Edit mode: Off' }));
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Edit image/ })).not.toBeInTheDocument();
    expect(screen.getByText(/deletion only/)).toBeInTheDocument();
  });

  it('keeps read-only conversation files viewable without edit controls', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      content: { kind: 'text', content: 'read only', encoding: 'utf-8', category: 'plain' },
      capability: { kind: 'read_only', reason: 'Explore conversations are read-only' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    render(
      <FileExplorerContext.Provider value={context}>
        <ReviewNotesProvider>
          <FileViewer filePath="notes.txt" rootDir="/tmp/project" conversationId="conv-1" onClose={() => undefined} onSendNotes={() => undefined} />
        </ReviewNotesProvider>
      </FileExplorerContext.Provider>,
    );
    expect(await screen.findByTestId('codeview-mock')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit mode/ })).not.toBeInTheDocument();
  });
});

/**
 * Reaching the editor from the review diff (REQ-FE-013, REQ-RV-006).
 *
 * The full provider stack is required: the diff mode is resolved from the
 * viewer slot's URL params, and the review manifest is what makes the open file
 * a reviewable one.
 */
describe('FileViewer edit from the review diff', () => {
  const MANIFEST: ReviewManifestResponse = {
    comparator: 'origin/main',
    files: [
      { path: 'notes.txt', status: 'modified', insertions: 1, deletions: 0, current_blob_sha: 'abc123', review: { kind: 'unreviewed' } },
      { path: 'image.png', status: 'modified', insertions: 0, deletions: 0, current_blob_sha: 'def456', review: { kind: 'unreviewed' } },
    ],
    reviewed_count: 0,
    total_count: 2,
  };

  let context: FileExplorerContextValue;

  beforeEach(() => {
    context = {
      openFile: vi.fn(),
      activeFile: null,
      closeFile: vi.fn(),
      openFileState: null,
      fileMutation: null,
      notifyFileMutation: vi.fn(),
      requestFileTransition: (transition) => transition(),
      registerFileTransitionGuard: () => () => undefined,
    };
    resetCodeViewMock();
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(api, 'getReviewFiles').mockResolvedValue(MANIFEST);
    vi.spyOn(api, 'getReviewFileDiff').mockImplementation(async (_conv, path, scope) => ({
      path,
      comparator: 'origin/main',
      scope,
      diff: 'diff --git a/notes.txt b/notes.txt\nindex 000..111 100644\n--- a/notes.txt\n+++ b/notes.txt\n@@ -0,0 +1 @@\n+hello\n',
      current_blob_sha: 'abc123',
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function renderInDiffMode(fileName: string) {
    return render(
      <MemoryRouter initialEntries={[`/c/slug?viewer=prose&file=/tmp/project/${fileName}&root=/tmp/project&mode=diff`]}>
        <ViewerSlotProvider scopeKey="conv-1" browserSessionActive={false}>
          <ReviewProvider conversationId="conv-1" rootDir="/tmp/project" enabled agentState="idle">
            <FileExplorerContext.Provider value={context}>
              <ReviewNotesProvider>
                <FileViewer
                  filePath={fileName}
                  rootDir="/tmp/project"
                  conversationId="conv-1"
                  onClose={() => undefined}
                  onSendNotes={() => undefined}
                />
              </ReviewNotesProvider>
            </FileExplorerContext.Provider>
          </ReviewProvider>
        </ViewerSlotProvider>
      </MemoryRouter>,
    );
  }

  function respondWithEditableText() {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      content: { kind: 'text', content: 'hello text file', encoding: 'utf-8', category: 'plain' },
      capability: { kind: 'mutable_text', version: 'version-one' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }

  /** The diff surface marks its own mode button pressed; source mode marks FILE
   *  instead. Waiting on this proves an assertion below is about the review
   *  diff and not the source-rendering fallback taken before the manifest
   *  arrives. */
  function findDiffSurface() {
    return screen.findByRole('button', { name: 'DIFF', pressed: true });
  }

  it('lands on the live source editor in one click', async () => {
    respondWithEditableText();
    renderInDiffMode('notes.txt');
    await findDiffSurface();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    // Armed on arrival: the editor is live without a second trip through the
    // Edit mode toggle.
    const editor = await screen.findByRole('textbox', { name: 'Edit notes.txt' });
    expect(editor).toHaveValue('hello text file');
    expect(screen.getByRole('button', { name: 'Edit mode: On' })).toBeInTheDocument();
    // Save stays disabled until the draft actually differs (REQ-FE-014).
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('does not offer Edit for an image, which is deletable but not text-editable', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      content: { kind: 'image', mime_type: 'image/png', url: '/preview/tmp/project/image.png' },
      capability: { kind: 'delete_only', version: 'image-version' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    renderInDiffMode('image.png');
    await findDiffSurface();

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('disarms when the reviewer leaves the editor, so the request cannot re-arm it', async () => {
    respondWithEditableText();
    renderInDiffMode('notes.txt');
    await findDiffSurface();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await screen.findByRole('textbox', { name: 'Edit notes.txt' });

    // The one-shot is consumed on arrival, so a clean disarm stays disarmed
    // rather than being undone by a re-render re-reading the request.
    fireEvent.click(screen.getByRole('button', { name: 'Edit mode: On' }));
    expect(await screen.findByRole('button', { name: 'Edit mode: Off' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Edit notes.txt' })).not.toBeInTheDocument();
  });
});

describe('FileViewer chrome under review focus', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderFocused(extra: Partial<React.ComponentProps<typeof FileViewer>> = {}) {
    return render(
      <ReviewNotesProvider>
        <FileViewer
          filePath="gone.ts"
          rootDir="/tmp/project"
          onClose={() => undefined}
          onSendNotes={() => undefined}
          reviewFocus
          onToggleReviewFocus={() => undefined}
          inline
          {...extra}
        />
      </ReviewNotesProvider>,
    );
  }

  /**
   * Review focus hides the conversation column, so every terminal state of the
   * viewer must still offer a way back — otherwise an unresolvable file leaves
   * the reviewer looking at a bare background.
   */
  it('keeps a close control and the review-focus toggle reachable while loading', () => {
    vi.mocked(fetch).mockReturnValue(new Promise(() => undefined));
    const onToggleReviewFocus = vi.fn();

    renderFocused({ onToggleReviewFocus });

    expect(screen.getByRole('button', { name: 'Close viewer' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show conversation' }));
    expect(onToggleReviewFocus).toHaveBeenCalledOnce();
  });

  it('keeps them reachable when the file fails to load', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(
      JSON.stringify({ error: 'No such file' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    ));

    renderFocused();

    expect(await screen.findByText('No such file')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close viewer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show conversation' })).toBeInTheDocument();
  });
});
