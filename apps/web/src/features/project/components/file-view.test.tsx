import { type FileContentResponse, PROBLEM_TYPE_BASE_URI } from '@repo/contracts';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ApiProblem } from '@/lib/api/problem';
import { renderScreen } from '@/test/render';
import { FileView } from './file-view';

/** The project head a read is answered against (spec 024 contract § 1). */
const BASE = '018f5f1e-0000-7000-8000-000000000001';

function readable(path: string, content: string): FileContentResponse {
  return { baseCheckpointId: BASE, bytes: content.length, content, path, renderable: true };
}

describe('FileView', () => {
  it('names the file, its size and every line', () => {
    const { container } = renderScreen(
      <FileView file={readable('src/a.ts', 'const x = 1;\nconst y = 2;')} />,
    );

    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('25 B')).toBeInTheDocument();
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe('12');
  });

  it('colours a file with a grammar and leaves one without it as plain text', () => {
    const { container, unmount } = renderScreen(
      <FileView file={readable('src/a.ts', 'const x = 1;')} />,
    );

    expect(container.querySelector('.hljs-keyword')).not.toBeNull();
    unmount();

    const plain = renderScreen(<FileView file={readable('src/main.rs', 'fn main() {}')} />);

    expect(plain.container.querySelector('.hljs-keyword')).toBeNull();
    expect(screen.getByText('fn main() {}')).toBeInTheDocument();
  });

  it('never lets a file’s own markup into the DOM', () => {
    const { container } = renderScreen(
      // Both branches matter: the highlighted one escapes through highlight.js, the fallback
      // through React's text children.
      <FileView file={readable('notes.md', '<img src=x onerror="alert(1)">')} />,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it('states why an unrenderable file has no contents', () => {
    renderScreen(
      <FileView file={{ bytes: 4096, path: 'logo.png', reason: 'binary', renderable: false }} />,
    );

    expect(screen.getByText('logo.png')).toBeInTheDocument();
    expect(screen.getByText('4.0 KB')).toBeInTheDocument();
    expect(
      screen.getByText('This file is binary, so it is not rendered here.'),
    ).toBeInTheDocument();
    expect(document.querySelector('pre')).toBeNull();
  });

  it('says so when the run refreshed what is on screen, and otherwise stays quiet', () => {
    const { unmount } = renderScreen(<FileView file={readable('a.ts', 'x')} />);

    expect(screen.queryByText('Refreshed by the run')).not.toBeInTheDocument();
    unmount();

    renderScreen(<FileView file={readable('a.ts', 'x')} refreshedByRun />);

    expect(screen.getByText('Refreshed by the run')).toBeInTheDocument();
  });
});

/**
 * What each project role holds, in the shape `ProjectResponse.permissions` carries it
 * (`rbac/permissions.ts` § PROJECT_ROLE_PERMISSIONS). The gate is the permission, never the role
 * name, so these are spelled out rather than summarised.
 */
const ROLES = {
  commenter: ['project:comment.create', 'project:read'],
  editor: [
    'project:agent.run',
    'project:comment.create',
    'project:deploy',
    'project:files.write',
    'project:read',
  ],
  viewer: ['project:read'],
} as const satisfies Record<string, readonly string[]>;

describe('FileView · the save gate (FR-002, SC-007)', () => {
  it('gives an editor an editable view and a save control', () => {
    renderScreen(
      <FileView
        file={readable('src/a.ts', 'const x = 1;')}
        onSave={() => undefined}
        permissions={ROLES.editor}
      />,
    );

    const editor = screen.getByRole('textbox', { name: 'File contents' });

    expect(editor).toBeInTheDocument();
    expect(editor).toHaveValue('const x = 1;');
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it.each([['commenter'], ['viewer']] as const)(
    'gives a %s neither an editable view nor a save control',
    (role) => {
      renderScreen(
        <FileView
          file={readable('src/a.ts', 'const x = 1;')}
          onSave={() => undefined}
          permissions={ROLES[role]}
        />,
      );

      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
      // The file is still theirs to read: the gate removes the writing, not the reading.
      expect(document.querySelector('pre')?.textContent).toBe('const x = 1;');
    },
  );

  it('offers nothing to save on a file that cannot be rendered, whoever is asking', () => {
    renderScreen(
      <FileView
        file={{ bytes: 4096, path: 'logo.png', reason: 'binary', renderable: false }}
        onSave={() => undefined}
        permissions={ROLES.editor}
      />,
    );

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('hands the edited text to the save', async () => {
    const onSave = vi.fn();

    renderScreen(
      <FileView
        file={readable('src/a.ts', 'const x = 1;')}
        onSave={onSave}
        permissions={ROLES.editor}
      />,
    );

    const editor = screen.getByRole('textbox', { name: 'File contents' });

    await userEvent.clear(editor);
    await userEvent.type(editor, 'const x = 2;');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith('const x = 2;');
  });
});

/** A `409` from the save route, shaped as the API's exception filter renders one (RFC 9457). */
function conflict(reason: string): ApiProblem {
  return new ApiProblem(409, {
    detail: 'The project has moved since this file was read.',
    instance: '/api/v1/orgs/o/projects/p/files/content',
    reason,
    requestId: '01JD0000000000000000000000',
    status: 409,
    title: 'Conflict',
    type: `${PROBLEM_TYPE_BASE_URI}conflict`,
  });
}

/** The read the refetch answers with: same path, newer base, somebody else's line. */
const MOVED: FileContentResponse = {
  baseCheckpointId: '018f5f1e-0000-7000-8000-00000000000b',
  bytes: 12,
  content: 'const x = 9;',
  path: 'src/a.ts',
  renderable: true,
};

/**
 * The editor as its caller drives it: the open file in state, the refusal in state, and a reload
 * that swaps in the newer read — which is what a refetch in `stage-code.tsx` does to these props.
 *
 * A harness rather than `rerender`, because what is under test is what survives a new `file` prop
 * arriving: re-rendering the view from the root would remount it and throw away the very draft the
 * test is about.
 */
function Editor({ onSave }: { onSave?: (content: string) => void }): React.JSX.Element {
  const [file, setFile] = useState<FileContentResponse>(readable('src/a.ts', 'const x = 1;'));
  const [saveError, setSaveError] = useState<Error | null>(conflict('base-moved'));

  return (
    <FileView
      file={file}
      onReload={() => {
        setFile(MOVED);
        // The refusal named a base that no longer exists: leaving it on screen after the reload
        // would be telling the person about a file they are no longer looking at.
        setSaveError(null);
      }}
      onSave={onSave ?? (() => undefined)}
      permissions={ROLES.editor}
      saveError={saveError}
    />
  );
}

describe('FileView \u00b7 a save refused because the base moved (FR-022, SC-010)', () => {
  it('says to reload, and offers the reload itself', () => {
    renderScreen(
      <FileView
        file={readable('src/a.ts', 'const x = 1;')}
        onReload={() => undefined}
        onSave={() => undefined}
        permissions={ROLES.editor}
        saveError={conflict('base-moved')}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'This file changed after you opened it, so your save was refused. Reload it to pick up the current version \u2014 your own edits stay in the editor.',
    );
    expect(screen.getByRole('button', { name: 'Reload the file' })).toBeInTheDocument();
  });

  it('falls back to the shared conflict sentence when nothing offers the reload', () => {
    // The sentence promises an action, so it is only told to somebody who has been given one.
    renderScreen(
      <FileView
        file={readable('src/a.ts', 'const x = 1;')}
        onSave={() => undefined}
        permissions={ROLES.editor}
        saveError={conflict('base-moved')}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'That conflicts with something that already exists.',
    );
    expect(screen.queryByRole('button', { name: 'Reload the file' })).not.toBeInTheDocument();
  });

  it('reloads without discarding the edits, and the save that follows goes through', async () => {
    const onSave = vi.fn();

    renderScreen(<Editor onSave={onSave} />);

    const editor = screen.getByRole('textbox', { name: 'File contents' });

    await userEvent.clear(editor);
    await userEvent.type(editor, 'const x = 2;');
    await userEvent.click(screen.getByRole('button', { name: 'Reload the file' }));

    // Still in the editor, still holding what was typed: the reload brought a new base, not a new
    // start (FR-022), and it says as much rather than leaving the person to notice.
    expect(screen.getByRole('textbox', { name: 'File contents' })).toHaveValue('const x = 2;');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Reloaded. Your edits are still here \u2014 saving now replaces the version you just reloaded.',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith('const x = 2;');
  });

  it('takes the newer read when there is nothing of the person\u2019s to keep', async () => {
    renderScreen(<Editor />);

    await userEvent.click(screen.getByRole('button', { name: 'Reload the file' }));

    // Nothing was typed, so there is nothing to protect and nothing to announce.
    expect(screen.getByRole('textbox', { name: 'File contents' })).toHaveValue('const x = 9;');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  /*
   * Supersedes 'leaves the other refusals to the shared sentence, reload and all', which asserted
   * `run-active` took the generic sentence. That was Phase 4 describing what it had not built yet;
   * T041 builds it, so the assertion inverts and the unknown-reason half of it moves below, where
   * it still holds.
   */
  it('tells a save refused by a live run to wait, and offers nothing to press (FR-019)', () => {
    renderScreen(
      <FileView
        file={readable('src/a.ts', 'const x = 1;')}
        onReload={() => undefined}
        onSave={() => undefined}
        permissions={ROLES.editor}
        saveError={conflict('run-active')}
      />,
    );

    const alert = screen.getByRole('alert');

    // The remedy is in the words, and it is a different remedy from `base-moved`'s: waiting, not
    // reloading. Asserted against the reload sentence too, because the whole of FR-019 is that the
    // two refusals cannot be mistaken for one another.
    expect(alert).toHaveTextContent(
      'A run is working on this project, so your save was refused. Wait for the run to finish, then save again \u2014 your edits stay in the editor.',
    );
    expect(alert).not.toHaveTextContent('Reload it to pick up the current version');
    expect(screen.queryByRole('button', { name: 'Reload the file' })).not.toBeInTheDocument();
  });

  it('falls back to the shared sentence for a reason this build does not know', () => {
    // A newer server naming a third reason must not render a blank alert: the parse yields
    // `undefined` and the shared catalogue answers, exactly as an unparsed reason always did.
    renderScreen(
      <FileView
        file={readable('src/a.ts', 'const x = 1;')}
        onReload={() => undefined}
        onSave={() => undefined}
        permissions={ROLES.editor}
        saveError={conflict('sandbox-recycled')}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'That conflicts with something that already exists.',
    );
    expect(screen.queryByRole('button', { name: 'Reload the file' })).not.toBeInTheDocument();
  });
});
