import type { FileContentResponse, FileEntry } from '@repo/contracts';
import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { type PatchedFile, StageCode } from './stage-code';

const ORG_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const FILES = `${API}/orgs/${ORG_ID}/projects/${PROJECT_ID}/files`;

const TREE: Record<string, FileEntry[]> = {
  '': [
    { kind: 'file', name: 'readme.md', size: 12 },
    { kind: 'directory', name: 'src', size: 0 },
  ],
  src: [{ kind: 'file', name: 'main.ts', size: 21 }],
};

/** The listing route, answered from a map of directories the test owns. */
function listing(tree: Record<string, FileEntry[]> = TREE) {
  return http.get(FILES, ({ request }) => {
    const path = new URL(request.url).searchParams.get('path') ?? '';
    const entries = tree[path];

    return entries === undefined
      ? problemResponse('not-found', 404)
      : HttpResponse.json({ entries, path });
  });
}

/** The content route. `read` is a function so a test can change its answer between refetches. */
function content(read: (path: string) => FileContentResponse) {
  return http.get(`${FILES}/content`, ({ request }) =>
    HttpResponse.json(read(new URL(request.url).searchParams.get('path') ?? '')),
  );
}

/** The project head a read is answered against (spec 024 contract § 1). */
const BASE = '018f5f1e-0000-7000-8000-000000000001';

function readable(path: string, text: string): FileContentResponse {
  return { baseCheckpointId: BASE, bytes: text.length, content: text, path, renderable: true };
}

/** The 409 the API answers every sandbox read with while the sandbox is asleep. */
function asleep() {
  return problemResponse('conflict', 409, { extensions: { kind: 'sandbox-not-ready' } });
}

describe('StageCode', () => {
  it('SC-001: lists the tree and opens a file with its exact contents', async () => {
    server.use(
      listing(),
      content((path) => readable(path, 'export const x = 1;')),
    );

    renderScreen(<StageCode orgId={ORG_ID} projectId={PROJECT_ID} />);

    expect(await screen.findByRole('tree', { name: 'Project files' })).toBeInTheDocument();
    await userEvent.click(await screen.findByText('src'));
    await userEvent.click(await screen.findByText('main.ts'));

    expect(await screen.findByText('src/main.ts')).toBeInTheDocument();
    expect(screen.getByText('19 B')).toBeInTheDocument();
    expect(document.querySelector('pre')?.textContent).toBe('export const x = 1;');
  });

  it('FR-003: a binary file shows name and size and no content', async () => {
    server.use(
      listing({ '': [{ kind: 'file', name: 'logo.png', size: 4096 }] }),
      content((path) => ({ bytes: 4096, path, reason: 'binary', renderable: false })),
    );

    renderScreen(<StageCode orgId={ORG_ID} projectId={PROJECT_ID} />);

    await userEvent.click(await screen.findByText('logo.png'));

    expect(await screen.findByText('4.0 KB')).toBeInTheDocument();
    expect(
      screen.getByText('This file is binary, so it is not rendered here.'),
    ).toBeInTheDocument();
    expect(document.querySelector('pre')).toBeNull();
  });

  it('SC-002: a file.patch event refetches the open file and marks it refreshed', async () => {
    let text = 'before';

    server.use(
      listing(),
      content((path) => readable(path, text)),
    );

    /*
     * The stream's two effects, side by side: `project-page.tsx` invalidates the open file and
     * hands the stage a *new* `patched` object. The marking is identity-compared, so a second
     * patch to the same path has to be a second object to be seen at all.
     */
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false, staleTime: 0 } },
    });

    function Harness() {
      // Opening starts from a patch that has already been and gone, so the marking can only come
      // from the *next* one — an equal object would not do.
      const [patched, setPatched] = useState<PatchedFile | undefined>({ path: 'readme.md' });

      return (
        <>
          <button
            type="button"
            onClick={() => {
              text = 'after';
              setPatched({ path: 'readme.md' });
              void client.invalidateQueries({ queryKey: ['file', ORG_ID, PROJECT_ID] });
            }}
          >
            patch
          </button>
          <StageCode orgId={ORG_ID} patched={patched} projectId={PROJECT_ID} />
        </>
      );
    }

    renderScreen(<Harness />, { client });

    await userEvent.click(await screen.findByText('readme.md'));
    expect(await screen.findByText('before')).toBeInTheDocument();
    expect(screen.queryByText('Refreshed by the run')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'patch' }));

    expect(await screen.findByText('after')).toBeInTheDocument();
    expect(screen.getByText('Refreshed by the run')).toBeInTheDocument();
  });

  it('SC-005: an asleep sandbox wakes itself on opening and populates', async () => {
    let awake = false;

    server.use(
      http.get(FILES, ({ request }) => {
        if (!awake) return asleep();

        const path = new URL(request.url).searchParams.get('path') ?? '';

        return HttpResponse.json({ entries: TREE[path] ?? [], path });
      }),
      http.post(`${FILES}/wake`, () => {
        awake = true;

        return HttpResponse.json({ because: null, ready: true });
      }),
    );

    renderScreen(<StageCode orgId={ORG_ID} projectId={PROJECT_ID} />);

    expect(await screen.findByRole('tree', { name: 'Project files' })).toBeInTheDocument();
    expect(await screen.findByText('readme.md')).toBeInTheDocument();
  });

  it("SC-008: an archived project shows the console's sentence", async () => {
    // An archived project is hidden by `deleted_at`, so every read of it is the ordinary 404.
    server.use(http.get(FILES, () => problemResponse('not-found', 404)));

    renderScreen(<StageCode orgId={ORG_ID} projectId={PROJECT_ID} />);

    expect(await screen.findByText('We could not find that.')).toBeInTheDocument();
    expect(screen.getByText("The project's files are unavailable")).toBeInTheDocument();
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
  });

  it('SC-009: an empty directory renders empty', async () => {
    server.use(listing({ '': [] }));

    renderScreen(<StageCode orgId={ORG_ID} projectId={PROJECT_ID} />);

    expect(await screen.findByText('This project has no files.')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    });
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);
    for (const sample of ['src', 'readme.md', 'index.ts', 'main.ts', 'package.json']) {
      expect(screen.queryByText(sample)).not.toBeInTheDocument();
    }
  });

  it('FR-022: the reload a refused save offers is wired to a real refetch', async () => {
    /*
     * The wiring, not the view: `FileView` builds the whole `base-moved` affordance behind an
     * `onReload` prop, so until something passes one the button does not render at all and the
     * feature is dark in the running app however green `file-view.test.tsx` is. This drives the
     * stage as a person does — open, type, save, be refused — and then presses the button.
     */
    let reads = 0;

    server.use(
      http.get(`${API}/orgs/:orgId/projects/:projectId`, () =>
        HttpResponse.json({
          project: {
            createdAt: '2026-08-18T09:00:00.000Z',
            id: PROJECT_ID,
            name: 'On-call rota dashboard',
            permissions: ['project:read', 'project:files.write'],
          },
        }),
      ),
      listing(),
      content((path) => {
        reads += 1;

        return readable(path, reads === 1 ? 'const x = 1;' : 'const x = 9;');
      }),
      http.put(`${FILES}/content`, () =>
        problemResponse('conflict', 409, { reason: 'base-moved' }),
      ),
    );

    renderScreen(<StageCode orgId={ORG_ID} projectId={PROJECT_ID} />);

    await userEvent.click(await screen.findByText('readme.md'));

    const editor = await screen.findByRole('textbox', { name: 'File contents' });

    await userEvent.clear(editor);
    await userEvent.type(editor, 'const x = 2;');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    // The refusal reaches the view with its reason intact — the `reason` extension rides at the
    // top level of the problem document, which is where the API's filter spreads it.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This file changed after you opened it, so your save was refused.',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Reload the file' }));

    // A second read actually happened, the refusal is gone with the base it named, and the typing
    // survived the newer answer landing on top of it.
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(reads).toBeGreaterThan(1);
    expect(screen.getByRole('textbox', { name: 'File contents' })).toHaveValue('const x = 2;');
    expect(screen.getByRole('status')).toHaveTextContent('Reloaded. Your edits are still here');
  });
});
