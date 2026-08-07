import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ShortcutHelpPanel } from './ShortcutHelpPanel';
import { FocusScopeProvider } from '../hooks/useFocusScope';
import { REVIEW_BINDINGS } from './viewer/reviewKeymap';

describe('ShortcutHelpPanel', () => {
  it('documents every review binding, so a key cannot ship undiscoverable', () => {
    render(
      <FocusScopeProvider>
        <ShortcutHelpPanel visible onClose={() => undefined} />
      </FocusScopeProvider>,
    );

    expect(screen.getByText('Diff Review')).toBeInTheDocument();
    for (const binding of REVIEW_BINDINGS) {
      expect(screen.getByText(binding.description)).toBeInTheDocument();
    }
  });
});
