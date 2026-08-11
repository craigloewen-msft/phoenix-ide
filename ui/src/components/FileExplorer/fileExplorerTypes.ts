import { createContext } from 'react';
import type { ViewerFocus } from '../viewer/metaViewerTypes';

export interface PatchContext {
  modifiedLines: Set<number>;
  firstModifiedLine?: number;
}

export type OpenFileOptions =
  | { kind: 'patch'; patchContext: PatchContext }
  | { kind: 'line'; lineNumber: number }
  | { kind: 'range'; startLine: number; endLine: number };

export interface OpenFileState {
  path: string;
  rootDir: string;
  patchContext?: PatchContext;
  focus?: ViewerFocus;
}

export type FileMutation =
  | { kind: 'saved'; path: string; sequence: number }
  | { kind: 'deleted'; path: string; sequence: number };

export type FileTransitionGuard = (continueTransition: () => void) => boolean;

export interface FileExplorerContextValue {
  /** Open a file in the viewer */
  openFile: (path: string, rootDir: string, options?: OpenFileOptions, afterOpen?: () => void) => void;
  /** Currently open file, or null */
  activeFile: string | null;
  /** Close the file viewer */
  closeFile: () => void;
  /** Open-file state (path + rootDir + patchContext) */
  openFileState: OpenFileState | null;
  /** Latest successful file mutation, consumed by tree/Git/review owners. */
  fileMutation: FileMutation | null;
  notifyFileMutation: (mutation: Omit<FileMutation, 'sequence'>) => void;
  /** Run a slot/navigation transition now, or let the active dirty editor defer it. */
  requestFileTransition: (transition: () => void) => void;
  /** Registers the one active file viewer's dirty-exit guard. */
  registerFileTransitionGuard: (guard: FileTransitionGuard) => () => void;
}

export const FileExplorerContext = createContext<FileExplorerContextValue | null>(null);
