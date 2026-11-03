import { type PreviewStage, problemTypeUri } from '@repo/contracts';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PREVIEW_POLL_MS } from '../hooks/use-preview';

import { API, server } from '@/test/server';
import { renderScreen } from '@/test/render';
import { StagePreview } from './stage-preview';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const PREVIEW = `${API}/orgs/${ORG}/projects/${PROJECT}/preview`;
const WAKE = `${API}/orgs/${ORG}/projects/${PROJECT}/files/wake`;

const ROTATE = 'project:preview.rotate';

/** The 409 the API answers while the sandbox is hibernated (contracts/files.md § 1). */
function asleep() {
  return HttpResponse.json(
    {
      detail: 'The sandbox is not ready.',
      extensions: { kind: 'sandbox-not-ready', state: 'hibernated' },
      instance: `/api/v1/orgs/${ORG}/projects/${PROJECT}/preview`,
      requestId: '01JD0000000000000000000000',
      status: 409,
      title: 'Conflict',
      // The real base URI, or `ApiProblem.slug` — and so `isAsleep` — comes back undefined.
      type: problemTypeUri('conflict'),
    },
    { status: 409 },
  );
}

function stage(permissions: readonly string[] = []) {
  return <StagePreview orgId={ORG} permissions={permissions} phase="ready" projectId={PROJECT} />;
}

/**
 * `POST /preview/authorize`: a fresh, numbered code per call at the host the stage asked for, so
 * a test can tell a newly minted code from a reused one.
 */
let minted = 0;

function authorizing() {
  return http.post(`${API}/preview/authorize`, async ({ request }) => {
    const { returnHost } = (await request.json()) as { returnHost: string };
    minted += 1;

    return HttpResponse.json({ url: `https://${returnHost}/?code=${String(minted)}` });
  });
}

/** The iframe on screen, as an identity: a remount gives back a different element. */
function frame(): HTMLIFrameElement {
  const element = document.querySelector('iframe');

  if (element === null) {
    throw new Error('no preview frame on screen');
  }

  return element;
}

describe('StagePreview', () => {
  beforeEach(() => {
    minted = 0;
    server.use(authorizing());
  });

  it('SC-004: loads the label host with no run in progress and shows address and visibility', async () => {
    server.use(
      http.get(PREVIEW, () =>
        HttpResponse.json({
          port: 3000,
          stage: 'ready',
          url: 'https://a.preview.test',
          visibility: 'org',
        }),
      ),
    );

    renderScreen(stage());

    expect(await screen.findByText('https://a.preview.test')).toBeInTheDocument();
    expect(screen.getByText('org')).toBeInTheDocument();
    await waitFor(() => expect(frame()).toHaveAttribute('src', 'https://a.preview.test/?code=1'));
  });

  it('FR-015: rotate changes the address and reloads the frame; a viewer sees no rotate or visibility control', async () => {
    let url = 'https://a.preview.test';

    server.use(
      http.get(PREVIEW, () =>
        HttpResponse.json({ port: 3000, stage: 'ready', url, visibility: 'private' }),
      ),
      http.post(`${PREVIEW}/rotate`, () => {
        url = 'https://b.preview.test';

        return HttpResponse.json({ port: 3000, status: 'preview-label-rotated', url });
      }),
    );

    const { unmount } = renderScreen(stage([ROTATE]));

    expect(await screen.findByText('https://a.preview.test')).toBeInTheDocument();
    await waitFor(() => expect(frame()).toHaveAttribute('src', 'https://a.preview.test/?code=1'));

    const before = frame();

    await userEvent.click(screen.getByRole('button', { name: 'Rotate' }));

    expect(await screen.findByText('https://b.preview.test')).toBeInTheDocument();
    await waitFor(() => expect(frame()).toHaveAttribute('src', 'https://b.preview.test/?code=2'));
    // Not merely the new address: the element itself is a new one, so the document reloaded.
    expect(frame()).not.toBe(before);

    unmount();

    renderScreen(stage());

    expect(await screen.findByText('https://b.preview.test')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rotate' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Preview visibility')).not.toBeInTheDocument();
  });

  it('FR-016: a preview.ready event reloads the frame', async () => {
    server.use(
      http.get(PREVIEW, () =>
        HttpResponse.json({
          port: 3000,
          stage: 'ready',
          url: 'https://a.preview.test',
          visibility: 'private',
        }),
      ),
    );

    /** Stands in for the page, which counts `preview.ready` events off `useRunStream`. */
    function Harness(): React.JSX.Element {
      const [previewReadyCount, setCount] = useState(0);

      return (
        <>
          <button
            type="button"
            onClick={() => {
              setCount((count) => count + 1);
            }}
          >
            announce preview.ready
          </button>
          <StagePreview
            orgId={ORG}
            phase="ready"
            previewReadyCount={previewReadyCount}
            projectId={PROJECT}
          />
        </>
      );
    }

    renderScreen(<Harness />);

    expect(await screen.findByText('https://a.preview.test')).toBeInTheDocument();
    await waitFor(() => expect(frame()).toHaveAttribute('src', 'https://a.preview.test/?code=1'));

    const before = frame();

    await userEvent.click(screen.getByRole('button', { name: 'announce preview.ready' }));

    // The address is the label host either way; what the event buys is the remount, and a remount
    // needs a fresh code: the last one was spent redeeming the grant.
    await waitFor(() => expect(frame()).not.toBe(before));
    await waitFor(() => expect(frame()).toHaveAttribute('src', 'https://a.preview.test/?code=2'));
  });

  it('SC-005: an asleep project offers one wake and populates after', async () => {
    let woken = false;

    server.use(
      http.get(PREVIEW, () =>
        woken
          ? HttpResponse.json({
              port: 3000,
              stage: 'ready',
              url: 'https://a.preview.test',
              visibility: 'private',
            })
          : asleep(),
      ),
      http.post(WAKE, () => {
        woken = true;

        return HttpResponse.json({ because: null, ready: true });
      }),
    );

    renderScreen(stage());

    expect(await screen.findByText('This project is asleep')).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();

    const wake = screen.getAllByRole('button', { name: /^Wak/ });

    expect(wake).toHaveLength(1);

    await userEvent.click(wake[0]!);

    expect(await screen.findByText('https://a.preview.test')).toBeInTheDocument();
    await waitFor(() => expect(frame()).toHaveAttribute('src', 'https://a.preview.test/?code=1'));
    expect(screen.queryByText('This project is asleep')).not.toBeInTheDocument();
  });

  it('FR-017: the frame’s sandbox attribute is unchanged', async () => {
    server.use(
      http.get(PREVIEW, () =>
        HttpResponse.json({
          port: 3000,
          stage: 'ready',
          url: 'https://a.preview.test',
          visibility: 'private',
        }),
      ),
    );

    renderScreen(stage([ROTATE]));

    await waitFor(() => expect(frame()).toHaveAttribute('src', 'https://a.preview.test/?code=1'));

    // Exactly this, not a superset. `allow-same-origin` keeps the preview's own origin (without
    // it the frame is opaque and its module scripts fail CORS); no top navigation, no popups.
    expect(frame().getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-same-origin');
  });

  it('never frames a preview url on this application’s own origin', async () => {
    server.use(
      http.get(PREVIEW, () =>
        HttpResponse.json({
          port: 3000,
          stage: 'ready',
          url: window.location.origin,
          visibility: 'public',
        }),
      ),
    );

    renderScreen(stage([]));

    expect(await screen.findByText('No preview yet')).toBeInTheDocument();
    expect(screen.queryByTitle('Project preview')).not.toBeInTheDocument();
  });

  it('frames a public preview at its plain address, minting no code', async () => {
    server.use(
      http.get(PREVIEW, () =>
        HttpResponse.json({
          port: 3000,
          stage: 'ready',
          url: 'https://a.preview.test',
          visibility: 'public',
        }),
      ),
    );

    renderScreen(stage());

    await waitFor(() => expect(frame()).toHaveAttribute('src', 'https://a.preview.test'));
    expect(minted).toBe(0);
  });

  it('never frames a minted address on another host', async () => {
    server.use(
      http.get(PREVIEW, () =>
        HttpResponse.json({
          port: 3000,
          stage: 'ready',
          url: 'https://a.preview.test',
          visibility: 'private',
        }),
      ),
      http.post(`${API}/preview/authorize`, () =>
        HttpResponse.json({ url: 'https://evil.test/?code=1' }),
      ),
    );

    renderScreen(stage());

    expect(await screen.findByText('https://a.preview.test')).toBeInTheDocument();
    await waitFor(() => expect(frame()).toHaveAttribute('src', 'https://a.preview.test'));
  });
});

/** The preview at a stage, on a private label host. */
function at(stage: PreviewStage) {
  return HttpResponse.json({
    port: stage === 'ready' ? 3000 : null,
    stage,
    url: 'https://a.preview.test',
    visibility: 'private',
  });
}

/** Serves each stage in turn, then keeps serving the last, counting the asks. */
function stages(...sequence: PreviewStage[]) {
  const served = { count: 0 };

  server.use(
    http.get(PREVIEW, () => {
      const next = sequence[Math.min(served.count, sequence.length - 1)] ?? 'ready';

      served.count += 1;

      return at(next);
    }),
  );

  return served;
}

/** A start-up step's row, by its label. */
function step(label: string): HTMLElement {
  // `li span`: the run status chip in the toolbar says "Ready" too.
  const row = screen.getByText(label, { selector: 'li span' }).closest('li');

  if (row === null) throw new Error(`no step "${label}"`);

  return row;
}

const STEP_LABELS = [
  'Creating your sandbox',
  'Installing dependencies',
  'Starting the dev server',
  'Ready',
];

describe('StagePreview start-up', () => {
  beforeEach(() => {
    minted = 0;
    server.use(authorizing());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['creating', ['active', 'pending', 'pending', 'pending']],
    ['installing', ['done', 'active', 'pending', 'pending']],
    ['starting', ['done', 'done', 'active', 'pending']],
  ] as const)('walks the steps at %s, with no frame yet', async (current, expected) => {
    stages(current);
    renderScreen(stage());

    expect(await screen.findByText('Starting your preview')).toBeInTheDocument();
    expect(STEP_LABELS.map((label) => step(label).dataset.state)).toEqual(expected);
    expect(step(STEP_LABELS[expected.indexOf('active')]!)).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('progressbar', { name: 'Preview start-up' })).toBeInTheDocument();
    // An elapsed clock while it works.
    expect(screen.getByText(/^\d+ s$/u)).toBeInTheDocument();
    // No frame, and no grant code spent, before the gateway has a route.
    expect(document.querySelector('iframe')).toBeNull();
    expect(minted).toBe(0);
  });

  it('polls until ready, then mounts the frame and stops asking', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const served = stages('creating', 'installing', 'ready');

    renderScreen(stage());

    expect(await screen.findByText('Starting your preview')).toBeInTheDocument();
    expect(step('Creating your sandbox').dataset.state).toBe('active');

    await act(() => vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS));
    await waitFor(() => expect(step('Installing dependencies').dataset.state).toBe('active'));
    expect(document.querySelector('iframe')).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS));
    await waitFor(() => expect(frame()).toHaveAttribute('src', 'https://a.preview.test/?code=1'));
    // The steps lie over the frame, all done, until it has loaded and they fade away.
    expect(step('Ready').dataset.state).toBe('done');

    const asked = served.count;

    await act(() => vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS * 4));
    expect(served.count).toBe(asked);
  });

  it('names the step a failure stopped on and retries with a wake', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let woken = false;
    let polled = 0;

    server.use(
      http.get(PREVIEW, () => {
        polled += 1;
        if (woken) return at('ready');
        return at(polled === 1 ? 'installing' : 'failed');
      }),
      http.post(WAKE, () => {
        woken = true;

        return HttpResponse.json({ because: 'resuming', ready: false });
      }),
    );
    const user = userEvent.setup({
      advanceTimers: (ms) => {
        vi.advanceTimersByTime(ms);
      },
    });

    renderScreen(stage());

    expect(await screen.findByText('Starting your preview')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS));

    expect(
      await screen.findByRole('group', { name: 'Your preview could not start' }),
    ).toBeInTheDocument();
    expect(step('Creating your sandbox').dataset.state).toBe('done');
    expect(step('Installing dependencies').dataset.state).toBe('failed');
    expect(document.querySelector('iframe')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(frame()).toHaveAttribute('src', 'https://a.preview.test/?code=1'));
    expect(woken).toBe(true);
  });

  it('a preview already ready is framed straight away, with no steps', async () => {
    stages('ready');
    renderScreen(stage());

    await waitFor(() => expect(frame()).toHaveAttribute('src', 'https://a.preview.test/?code=1'));
    expect(screen.queryByText('Starting your preview')).not.toBeInTheDocument();
  });

  it('a project with no sandbox yet says so and frames nothing', async () => {
    stages('no-sandbox');
    renderScreen(stage());

    expect(await screen.findByText('No preview yet')).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });
});
