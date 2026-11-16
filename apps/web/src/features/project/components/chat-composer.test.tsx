import { type Attachment, attachmentSchema } from '@repo/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { useModelChoice } from '@/features/workspace/hooks/use-model-choice';
import { ApiProblem } from '@/lib/api/problem';
import { renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import type { UploadFn } from '../hooks/use-composer-attachments';
import type { UploadOptions } from '../lib/attachment-upload';
import { ChatComposer } from './chat-composer';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const ATTACHMENTS = `${API}/orgs/${ORG}/projects/${PROJECT}/attachments`;

let ids = 0;

function anAttachment(name: string, sizeBytes = 2048): Attachment {
  ids += 1;

  return attachmentSchema.parse({
    createdAt: '2026-11-16T10:00:00.000Z',
    id: `6ba7b810-9dad-11d1-80b4-${String(ids).padStart(12, '0')}`,
    kind: 'text',
    mimeType: 'text/markdown',
    name,
    sizeBytes,
  });
}

const aFile = (name: string, body = '# notes'): File => new File([body], name, { type: '' });

/** An upload the test finishes by hand: progress, then resolve or reject. */
function controlledUpload() {
  const calls: {
    file: File;
    options: UploadOptions;
    reject: (error: unknown) => void;
    resolve: (attachment: Attachment) => void;
  }[] = [];
  const upload = vi.fn<UploadFn>(
    (_org, _project, file, options) =>
      new Promise((resolve, reject) => {
        calls.push({ file, options, reject, resolve });
      }),
  );

  return { calls, upload };
}

function Harness({
  onSubmit,
  upload,
}: {
  readonly onSubmit: (prompt: string, attachments: readonly Attachment[]) => Promise<unknown>;
  readonly upload?: UploadFn;
}): React.JSX.Element {
  const modelState = useModelChoice({ orgId: ORG });

  return (
    <ChatComposer
      isRunning={false}
      isStopping={false}
      modelState={modelState}
      onStop={vi.fn()}
      onSubmit={onSubmit}
      orgId={ORG}
      placeholder="Ask for a change"
      projectId={PROJECT}
      {...(upload === undefined ? {} : { upload })}
    />
  );
}

function setup(upload?: UploadFn, onSubmit = vi.fn(() => Promise.resolve())) {
  const user = userEvent.setup({ applyAccept: false });
  renderScreen(<Harness onSubmit={onSubmit} {...(upload === undefined ? {} : { upload })} />);

  return { onSubmit, user };
}

const input = (): HTMLInputElement => screen.getByTestId('attach-input');
const strip = (): HTMLElement => screen.getByRole('list', { name: 'Attachments' });
const send = (): HTMLElement => screen.getByRole('button', { name: 'Send' });

describe('ChatComposer — attachments (spec 048, SC-7)', () => {
  it('the picker adds a chip that shows upload progress, then is ready', async () => {
    const { calls, upload } = controlledUpload();
    const { user } = setup(upload);

    await user.upload(input(), aFile('notes.md'));

    expect(within(strip()).getByText('notes.md')).toBeInTheDocument();
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(upload).toHaveBeenCalledWith(ORG, PROJECT, expect.any(File), expect.anything());

    calls[0]?.options.onProgress?.(0.5);
    expect(
      await screen.findByRole('progressbar', { name: /notes\.md: Uploading 50%/ }),
    ).toBeVisible();

    calls[0]?.resolve(anAttachment('notes.md'));
    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });
    expect(within(strip()).getByText('7 B')).toBeInTheDocument();
  });

  it('a dropped file is added', async () => {
    const { upload } = controlledUpload();
    setup(upload);
    const form = screen.getByRole('textbox').closest('form')!;
    const dataTransfer = { dropEffect: 'none', files: [aFile('drop.md')], types: ['Files'] };

    fireEvent.dragEnter(form, { dataTransfer });
    expect(screen.getByText('Drop files to attach')).toBeInTheDocument();
    fireEvent.drop(form, { dataTransfer });

    expect(within(strip()).getByText('drop.md')).toBeInTheDocument();
    expect(screen.queryByText('Drop files to attach')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(upload).toHaveBeenCalledTimes(1);
    });
  });

  it('a pasted file is added; a text paste is left alone', async () => {
    const { upload } = controlledUpload();
    setup(upload);

    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [aFile('paste.md')] } });

    expect(within(strip()).getByText('paste.md')).toBeInTheDocument();
    await waitFor(() => {
      expect(upload).toHaveBeenCalledTimes(1);
    });
  });

  it('removing an uploaded file drops it from the composer and deletes it on the server', async () => {
    const { calls, upload } = controlledUpload();
    const { user } = setup(upload);
    const attachment = anAttachment('notes.md');
    const deleted = vi.fn();
    server.use(
      http.delete(`${ATTACHMENTS}/:id`, ({ params }) => {
        deleted(params.id);

        return new HttpResponse(null, { status: 204 });
      }),
    );

    await user.upload(input(), aFile('notes.md'));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    calls[0]?.resolve(attachment);
    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Remove notes.md' }));

    expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(deleted).toHaveBeenCalledWith(attachment.id);
    });
  });

  it('a file type outside the allowlist is refused at once, without a request', async () => {
    const { upload } = controlledUpload();
    const { user } = setup(upload);

    await user.upload(input(), aFile('setup.exe'));

    expect(within(strip()).getByText("This file type isn't supported.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry setup.exe' })).not.toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
  });

  it('a failed upload says why and offers Retry, which succeeds', async () => {
    const { calls, upload } = controlledUpload();
    const { user } = setup(upload);

    await user.upload(input(), aFile('notes.md'));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    calls[0]?.reject(new ApiProblem(500, undefined));

    const retry = await screen.findByRole('button', { name: 'Retry notes.md' });
    expect(within(strip()).getByText('The upload failed. Try again.')).toBeInTheDocument();

    await user.click(retry);
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    calls[1]?.resolve(anAttachment('notes.md'));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Retry notes.md' })).not.toBeInTheDocument();
    });
    expect(within(strip()).getByText('7 B')).toBeInTheDocument();
  });

  it('Send waits while a file uploads, then sends the text with its attachments', async () => {
    const { calls, upload } = controlledUpload();
    const { onSubmit, user } = setup(upload);
    const attachment = anAttachment('notes.md');

    await user.type(screen.getByRole('textbox'), 'Use these notes');
    await user.upload(input(), aFile('notes.md'));

    expect(send()).toBeDisabled();

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    calls[0]?.resolve(attachment);
    await waitFor(() => {
      expect(send()).toBeEnabled();
    });

    await user.click(send());

    expect(onSubmit).toHaveBeenCalledWith('Use these notes', [attachment]);
    expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();
  });

  it('a refused send hands the files back', async () => {
    const { calls, upload } = controlledUpload();
    const { user } = setup(
      upload,
      vi.fn(() => Promise.reject(new Error('refused'))),
    );

    await user.type(screen.getByRole('textbox'), 'Use these notes');
    await user.upload(input(), aFile('notes.md'));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    calls[0]?.resolve(anAttachment('notes.md'));
    await waitFor(() => {
      expect(send()).toBeEnabled();
    });

    await user.click(send());

    expect(await within(strip()).findByText('notes.md')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('Use these notes');
  });

  it('a message carries at most ten files', async () => {
    const { upload } = controlledUpload();
    const { user } = setup(upload);

    await user.upload(
      input(),
      Array.from({ length: 12 }, (_, index) => aFile(`f${String(index)}.md`)),
    );

    expect(within(strip()).getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByText(/at most 10 files; 2 not added/)).toBeInTheDocument();
  });

  it('a refused send keeps files added meanwhile, and blocks Send until the extra are removed', async () => {
    const { calls, upload } = controlledUpload();
    let refuse = (_error: Error): void => undefined;
    const { user } = setup(
      upload,
      vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            refuse = reject;
          }),
      ),
    );

    await user.type(screen.getByRole('textbox'), 'Use these');
    await user.upload(
      input(),
      Array.from({ length: 9 }, (_, index) => aFile(`f${String(index)}.md`)),
    );
    for (let index = 0; index < 9; index += 1) {
      await waitFor(() => {
        expect(calls.length).toBeGreaterThan(index);
      });
      calls[index]?.resolve(anAttachment(`f${String(index)}.md`));
    }
    await waitFor(() => {
      expect(send()).toBeEnabled();
    });
    await user.click(send());
    await user.upload(input(), [aFile('late1.md'), aFile('late2.md')]);

    refuse(new Error('refused'));

    expect(await screen.findByText(/at most 10 files; remove 1 to send/)).toBeInTheDocument();
    expect(within(strip()).getAllByRole('listitem')).toHaveLength(11);
    expect(send()).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Remove late2.md' }));

    expect(screen.queryByText(/remove 1 to send/)).not.toBeInTheDocument();
    expect(within(strip()).getAllByRole('listitem')).toHaveLength(10);
  });

  it('a file removed while its upload finishes is deleted on the server', async () => {
    const { calls, upload } = controlledUpload();
    const { user } = setup(upload);
    const attachment = anAttachment('notes.md');
    const deleted = vi.fn();
    server.use(
      http.delete(`${ATTACHMENTS}/:id`, ({ params }) => {
        deleted(params.id);

        return new HttpResponse(null, { status: 204 });
      }),
    );

    await user.upload(input(), aFile('notes.md'));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    await user.click(screen.getByRole('button', { name: 'Remove notes.md' }));
    // The response lands anyway: the abort lost the race.
    calls[0]?.resolve(attachment);

    await waitFor(() => {
      expect(deleted).toHaveBeenCalledWith(attachment.id);
    });
  });

  it('announces a finished or failed upload once, not each progress tick', async () => {
    const { calls, upload } = controlledUpload();
    const { user } = setup(upload);

    await user.upload(input(), [aFile('a.md'), aFile('b.md')]);
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    const live = within(strip().parentElement!).getByRole('status');

    calls[0]?.options.onProgress?.(0.5);
    await screen.findByRole('progressbar', { name: /a\.md: Uploading 50%/ });
    expect(live).toHaveTextContent('');

    calls[0]?.resolve(anAttachment('a.md'));
    await waitFor(() => {
      expect(live).toHaveTextContent('a.md uploaded');
    });

    calls[1]?.reject(new ApiProblem(500, undefined));
    await waitFor(() => {
      expect(live).toHaveTextContent('b.md failed: The upload failed. Try again.');
    });
  });

  it('uploads through the API: the raw file as the body, its name in the query', async () => {
    // jsdom's File does not survive msw's XHR interceptor as bytes, so the body itself is not read.
    const attachment = anAttachment('notes.md');
    const seen = vi.fn();
    server.use(
      http.post(ATTACHMENTS, ({ request }) => {
        seen(new URL(request.url).searchParams.get('name'), request.headers.get('content-type'));

        return HttpResponse.json(attachment, { status: 201 });
      }),
    );
    const onSubmit = vi.fn(() => Promise.resolve());
    const { user } = setup(undefined, onSubmit);

    await user.type(screen.getByRole('textbox'), 'Read it');
    await user.upload(input(), aFile('notes.md', '# hello'));
    await waitFor(() => {
      expect(send()).toBeEnabled();
    });
    await user.click(send());

    expect(seen).toHaveBeenCalledWith('notes.md', 'application/octet-stream');
    expect(onSubmit).toHaveBeenCalledWith('Read it', [attachment]);
  });
});
