import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type CodexLoginPreflight } from '../api';
import { refreshModels } from '../modelsPoller';

interface AccountChipProps {
  preflight: CodexLoginPreflight | null;
  onPreflightInvalidated: () => void;
}

function shortAccount(id: string | null): string {
  if (!id) return 'unknown';
  if (id.length <= 12) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

export function AccountChip({ preflight, onPreflightInvalidated }: AccountChipProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleSignOut = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.codexSignout();
      await refreshModels();
      onPreflightInvalidated();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, onPreflightInvalidated]);

  if (!preflight?.already_signed_in) return null;

  const tooltip = preflight.account_id
    ? `Signed in as ${shortAccount(preflight.account_id)}`
    : 'Signed in to Codex';

  return (
    <div className="account-chip-wrap" ref={wrapRef}>
      <button
        type="button"
        className="account-chip"
        title={tooltip}
        aria-label={tooltip}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Codex
      </button>
      {open && (
        <div className="account-chip-menu" role="menu">
          <div className="account-chip-menu-header">
            <div className="account-chip-menu-label">Signed in to Codex</div>
            {preflight.account_id && (
              <div className="account-chip-menu-id" title={preflight.account_id}>
                <code>{shortAccount(preflight.account_id)}</code>
              </div>
            )}
          </div>
          {error && <div className="account-chip-menu-error">{error}</div>}
          <button
            type="button"
            className="account-chip-menu-item"
            onClick={() => { void handleSignOut(); }}
            disabled={busy}
            role="menuitem"
          >
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}
