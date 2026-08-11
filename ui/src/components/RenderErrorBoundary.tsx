/**
 * Contains a render or layout-effect throw to one subtree.
 *
 * React's default for an uncaught render error is to unmount the entire tree,
 * so without a boundary anywhere above it, one component that throws takes the
 * whole session with it — the window goes blank and the work on screen is
 * unrecoverable. That trade is only ever right when the failure means the app
 * can no longer be trusted; for a single view rendering a single file it is
 * wildly disproportionate.
 *
 * The boundary latches: once a subtree has thrown, re-rendering the same
 * children would throw again, so the fallback stays until `resetKey` changes.
 * The key is what makes recovery meaningful rather than a retry loop — it names
 * the input the subtree failed on, so a *different* input gets a fresh attempt
 * and the same one does not.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface RenderErrorBoundaryProps {
  children: ReactNode;
  /** Rendered in place of the children after a throw. Receives the error so the
   *  surface can say what failed rather than only that something did. */
  fallback: (error: Error) => ReactNode;
  /** Identifies the input the children are rendering. A change clears a latched
   *  error and remounts them. */
  resetKey?: string;
  /** Reported alongside the error so logs name the failing surface. */
  label: string;
}

interface RenderErrorBoundaryState {
  error: Error | null;
  /** The `resetKey` the latched error belongs to, so a change can be detected
   *  without a separate lifecycle hook. */
  errorKey: string | undefined;
}

export class RenderErrorBoundary extends Component<RenderErrorBoundaryProps, RenderErrorBoundaryState> {
  override state: RenderErrorBoundaryState = { error: null, errorKey: undefined };

  static getDerivedStateFromError(error: Error): Partial<RenderErrorBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: RenderErrorBoundaryProps,
    state: RenderErrorBoundaryState,
  ): Partial<RenderErrorBoundaryState> | null {
    if (state.error === null) return { errorKey: props.resetKey };
    if (state.errorKey === props.resetKey) return null;
    return { error: null, errorKey: props.resetKey };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Without this the failure is invisible: the fallback renders and nothing
    // records what could not be displayed, or where.
    console.error(`[render-error] ${this.props.label} failed to render`, error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    return error === null ? this.props.children : this.props.fallback(error);
  }
}
