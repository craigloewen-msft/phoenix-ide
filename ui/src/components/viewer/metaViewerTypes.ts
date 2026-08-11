/**
 * MetaViewer payload contract.
 *
 * A `MetaViewerPayload` is a *resolved, renderable* view of content — the
 * loader (FileViewer for files) has already fetched bytes and classified the
 * render kind. MetaViewer routes a payload to exactly one body renderer; it
 * never fetches. This is the typed boundary the diff-renderer replacement
 * plugs into: a new diff body becomes a renderer swap behind this shape, not
 * another architectural change.
 *
 * Image is a first-class payload kind here, not a special case bolted onto the
 * loader — every viewable thing flows through the same router.
 */

export type TextRenderMode = 'rich' | 'plainLargeText';

export type ViewerFocus =
  | { kind: 'line'; lineNumber: number }
  | { kind: 'range'; startLine: number; endLine: number };

export interface PatchContext {
  modifiedLines: Set<number>;
  firstModifiedLine?: number | undefined;
}

export type FileMutationCapability =
  | { kind: 'mutable_text'; version: string }
  | { kind: 'delete_only'; version: string };

export interface FileMutationActions {
  conversationId: string;
  relativePath: string;
  capability: FileMutationCapability;
  /**
   * Open this session already armed, honouring an explicit edit request made
   * from another render mode of the same file (the review diff's Edit button).
   *
   * One-shot: the viewer consumes it on mount via `onArmConsumed`, so a later
   * disarm cannot be silently undone by a re-render. It lives on the mutation
   * bundle — which exists only where mutation is possible — so "armed on a file
   * with no mutation capability" is unrepresentable.
   */
  armOnOpen: boolean;
  onArmConsumed: () => void;
  onSaved: (content: string, version: string) => void;
  onReloaded: (response: import('../../api').ConversationFileContentResponse) => void;
  onDeleted: () => void;
  registerTransitionGuard: (guard: (continueTransition: () => void) => boolean) => () => void;
}

interface CommonPayload {
  /** Header title — typically the file name. */
  title: string;
  /**
   * Stable viewer identity. Absolute path for files; used as the key for
   * scroll restoration and file-scoped review notes.
   */
  absolutePath: string;
  onClose: () => void;
  onSendNotes: (notes: string) => void | Promise<void>;
  /** Presentation selected by the URL-derived viewer slot. */
  presentation?: 'pane' | 'fullscreen' | undefined;
  /** Render inline (desktop split-pane) instead of as an overlay. */
  inline?: boolean | undefined;
  /** Whether a wide desktop pane is available as the alternate presentation. */
  canTogglePresentation?: boolean | undefined;
  onPresentationChange?: ((presentation: 'pane' | 'fullscreen') => void) | undefined;
  /** Present only for active conversation files whose server-scoped read grants mutation. */
  mutation?: FileMutationActions | undefined;
}

/** Shared shape for the four annotatable text render kinds. */
interface TextLikePayload extends CommonPayload {
  /** Initial line-addressable target; ranges require source-line rendering. */
  focus?: ViewerFocus | undefined;
  filePath: string;
  rootDir: string;
  content: string;
  renderMode?: TextRenderMode | undefined;
  patchContext?: PatchContext | undefined;
}

export interface MarkdownViewerPayload extends TextLikePayload {
  kind: 'markdown';
}

export interface CodeViewerPayload extends TextLikePayload {
  kind: 'code';
  /** Syntax-highlighter grammar identifier. */
  language: string;
}

export interface TextViewerPayload extends TextLikePayload {
  kind: 'text';
}

export interface HtmlViewerPayload extends TextLikePayload {
  kind: 'html';
  /** Syntax-highlighter grammar for source mode (`'html'`). */
  language: string;
  /** Sandboxed-preview + open-in-browser URL (`/preview<absolutePath>`). */
  previewUrl: string;
}

export interface ImageViewerPayload extends CommonPayload {
  kind: 'image';
  url: string;
  mimeType: string;
  fileName: string;
}

export type MetaViewerPayload =
  | MarkdownViewerPayload
  | CodeViewerPayload
  | TextViewerPayload
  | HtmlViewerPayload
  | ImageViewerPayload;

/** Payloads whose bodies render annotatable lines and carry file review notes. */
export type TextLikeViewerPayload =
  | MarkdownViewerPayload
  | CodeViewerPayload
  | TextViewerPayload
  | HtmlViewerPayload;

export function isTextLikePayload(
  payload: MetaViewerPayload,
): payload is TextLikeViewerPayload {
  return payload.kind !== 'image';
}
