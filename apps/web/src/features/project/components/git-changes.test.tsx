import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/test/render';
import { FileView } from './file-view';
import { GitChanges } from './git-changes';

describe('GitChanges', () => {
  /**
   * Supersedes 022's `it('no save form')` (024 T029, `supersedes.md` § 2).
   *
   * That test asserted no button anywhere in this pane, which stood for "the web surface is
   * read-only" (ADR 045) rather than for anything about this pane. ADR 047 reverses that half:
   * the surface writes now, so the blanket absence is no longer the truth being kept — it is
   * replaced by where the save actually is, asserted below, rather than narrowed away.
   *
   * The half proving the list renders is kept for the reason the old test's own comment gave:
   * an assertion about absence passes just as well against an empty render.
   */
  it('lists what the run changed, and holds no commit form of its own', () => {
    renderScreen(<GitChanges paths={['src/app.tsx', 'src/lib/rota.ts']} />);

    expect(screen.getByText('2 files changed since your last save')).toBeVisible();
    expect(screen.getByText('src/app.tsx')).toBeVisible();

    // A save is one file, saved from the editor (ADR 047, spec 024 § Assumptions). This pane
    // reports what the run touched; it never commits a batch of it.
    expect(screen.queryByText('Save these changes')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.querySelector('form')).toBeNull();
  });

  it('leaves the save to the editor, which offers one to a member who may write', () => {
    // The other end of the superseded assertion: the save control the read-only surface had none
    // of exists, on the file view, for a holder of `project:files.write` (FR-002, SC-009).
    renderScreen(
      <FileView
        file={{
          baseCheckpointId: '018f5f1e-0000-7000-8000-000000000001',
          bytes: 12,
          content: 'const x = 1;',
          path: 'src/app.tsx',
          renderable: true,
        }}
        onSave={() => undefined}
        permissions={['project:files.write', 'project:read']}
      />,
    );

    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'File contents' })).toHaveValue('const x = 1;');
  });
});
