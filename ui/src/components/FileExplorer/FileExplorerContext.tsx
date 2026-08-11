import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { FileExplorerContext } from './fileExplorerTypes';
import type { FileMutation, FileTransitionGuard, OpenFileState } from './fileExplorerTypes';
import { useViewerSlotData, useViewerSlotCommands } from '../../contexts/ViewerSlotContext';

/**
 * Back-compat adapter exposing the file-oriented view of the unified viewer
 * slot. The slot's URL contract, patch context, restoration, and mutex now live
 * in `ViewerSlotProvider` (which must wrap this); this provider just projects
 * the slot into the `{ openFile, closeFile, activeFile, openFileState }`
 * shape that the file explorer panel, command palette, and work actions consume.
 */
export function FileExplorerProvider({ children }: { children: ReactNode }) {
  const slot = useViewerSlotData();
  const { openProse, close } = useViewerSlotCommands();
  const transitionGuardRef = useRef<FileTransitionGuard | null>(null);
  const guardFileIdentityRef = useRef<string | null>(null);
  const mutationSequenceRef = useRef(0);
  const [fileMutation, setFileMutation] = useState<FileMutation | null>(null);

  const requestFileTransition = useCallback((transition: () => void) => {
    const guard = transitionGuardRef.current;
    if (guard) {
      try {
        if (guard(transition)) return;
      } catch (error) {
        transitionGuardRef.current = null;
        console.error('File transition guard failed; continuing navigation', error);
      }
    }
    transition();
  }, []);

  const registerFileTransitionGuard = useCallback((guard: FileTransitionGuard) => {
    transitionGuardRef.current = guard;
    return () => {
      if (transitionGuardRef.current === guard) transitionGuardRef.current = null;
    };
  }, []);

  const notifyFileMutation = useCallback((mutation: Omit<FileMutation, 'sequence'>) => {
    mutationSequenceRef.current += 1;
    const sequence = mutationSequenceRef.current;
    setFileMutation(mutation.kind === 'saved'
      ? { kind: 'saved', path: mutation.path, sequence }
      : { kind: 'deleted', path: mutation.path, sequence });
  }, []);

  const openFile = useCallback((
    path: string,
    rootDir: string,
    options?: Parameters<typeof openProse>[2],
    afterOpen?: () => void,
  ) => {
    requestFileTransition(() => {
      openProse(path, rootDir, options);
      afterOpen?.();
    });
  }, [openProse, requestFileTransition]);

  const closeFile = useCallback(() => {
    requestFileTransition(close);
  }, [close, requestFileTransition]);

  const openFileState = useMemo<OpenFileState | null>(() => {
    if (slot.kind !== 'prose') return null;
    const state: OpenFileState = { path: slot.file.path, rootDir: slot.file.rootDir };
    if (slot.patchContext) state.patchContext = slot.patchContext;
    if (slot.file.focus) state.focus = slot.file.focus;
    return state;
  }, [slot]);

  const fileIdentity = openFileState?.path ?? null;
  if (guardFileIdentityRef.current !== fileIdentity) {
    guardFileIdentityRef.current = fileIdentity;
    transitionGuardRef.current = null;
  }

  const value = useMemo(() => ({
    openFile,
    closeFile,
    activeFile: openFileState?.path ?? null,
    openFileState,
    fileMutation,
    notifyFileMutation,
    requestFileTransition,
    registerFileTransitionGuard,
  }), [
    openFile,
    closeFile,
    openFileState,
    fileMutation,
    notifyFileMutation,
    requestFileTransition,
    registerFileTransitionGuard,
  ]);

  return (
    <FileExplorerContext.Provider value={value}>
      {children}
    </FileExplorerContext.Provider>
  );
}
