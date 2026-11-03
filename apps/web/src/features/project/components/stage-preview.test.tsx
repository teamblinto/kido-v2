import { problemTypeUri } from '@repo/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

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
        HttpResponse.json({ port: 3000, url: 'https://a.preview.test', visibility: 'org' }),
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
      http.get(PREVIEW, () => HttpResponse.json({ port: 3000, url, visibility: 'private' })),
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
        HttpResponse.json({ port: 3000, url: 'https://a.preview.test', visibility: 'private' }),
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
          ? HttpResponse.json({ port: 3000, url: 'https://a.preview.test', visibility: 'private' })
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
        HttpResponse.json({ port: 3000, url: 'https://a.preview.test', visibility: 'private' }),
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
        HttpResponse.json({ port: 3000, url: window.location.origin, visibility: 'public' }),
      ),
    );

    renderScreen(stage([]));

    expect(await screen.findByText('No preview yet')).toBeInTheDocument();
    expect(screen.queryByTitle('Project preview')).not.toBeInTheDocument();
  });

  it('frames a public preview at its plain address, minting no code', async () => {
    server.use(
      http.get(PREVIEW, () =>
        HttpResponse.json({ port: 3000, url: 'https://a.preview.test', visibility: 'public' }),
      ),
    );

    renderScreen(stage());

    await waitFor(() => expect(frame()).toHaveAttribute('src', 'https://a.preview.test'));
    expect(minted).toBe(0);
  });

  it('never frames a minted address on another host', async () => {
    server.use(
      http.get(PREVIEW, () =>
        HttpResponse.json({ port: 3000, url: 'https://a.preview.test', visibility: 'private' }),
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
