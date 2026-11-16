import { type Attachment, ATTACHMENT_TYPES } from '@repo/contracts';
import { PaperclipIcon } from 'lucide-react';
import { useId, useRef, useState } from 'react';

import {
  CONNECT_TO_SEND,
  ComposerPrimaryAction,
  ConnectToPay,
} from '@/features/workspace/components/composer-parts';
import { ModelPicker } from '@/features/workspace/components/model-picker';
import type { ModelChoiceState } from '@/features/workspace/hooks/use-model-choice';
import { cn } from '@/lib/utils';
import { type UploadFn, useComposerAttachments } from '../hooks/use-composer-attachments';
import { PendingAttachmentStrip } from './attachment-parts';

/** The picker's filter: the allowlist's extensions (the server checks the bytes regardless). */
const ACCEPT = Object.keys(ATTACHMENT_TYPES)
  .map((extension) => `.${extension}`)
  .join(',');

interface ChatComposerProps {
  /** The run on screen waits for an answer: what is sent answers it rather than starting one. */
  isAnswering?: boolean;
  /** While a run is going the send button becomes Stop. */
  isRunning: boolean;
  /** A message is on its way: Send waits rather than sending it twice. */
  isSending?: boolean;
  /**
   * Whether a stop has been asked for and the run has not yet stopped.
   *
   * Its own state rather than the absence of `isRunning`, because that gap is the point: the API
   * records the request and answers at once, and the run ends when it ends (FR-012, SC-005).
   */
  isStopping: boolean;
  /** The model picker: what the next message runs on, and so who pays (spec 043). */
  modelState: ModelChoiceState;
  /** Nothing can pay for a run: the connect path shows instead of sending. */
  needsConnection?: boolean;
  onStop: () => void;
  /** Resolves once the message was accepted; a refusal hands the text and files back to the box. */
  onSubmit: (prompt: string, attachments: readonly Attachment[]) => Promise<unknown>;
  /** Where attachments are uploaded (spec 048). */
  orgId: string | undefined;
  placeholder: string;
  projectId: string;
  /** Tests swap the XHR upload for one they control. */
  upload?: UploadFn;
}

const hasFiles = (event: React.DragEvent): boolean => event.dataTransfer.types.includes('Files');

/** The box at the foot of the chat: send the next message, answer a waiting run, or stop one. */
export function ChatComposer({
  isAnswering = false,
  isRunning,
  isSending = false,
  isStopping,
  modelState,
  needsConnection = false,
  onStop,
  onSubmit,
  orgId,
  placeholder,
  projectId,
  upload,
}: ChatComposerProps): React.JSX.Element {
  const id = useId();
  const [prompt, setPrompt] = useState('');
  const attachments = useComposerAttachments(orgId, projectId, upload);
  const fileInput = useRef<HTMLInputElement>(null);
  // dragenter/dragleave fire for every child crossed; a count says when the pointer really left.
  const dragDepth = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const hasPrompt = prompt.trim().length > 0;
  const disabledReason = needsConnection
    ? CONNECT_TO_SEND
    : isSending
      ? 'Sending…'
      : attachments.isBusy
        ? 'Waiting for attachments to upload'
        : attachments.hasFailed
          ? 'Remove or retry the attachments that failed'
          : attachments.isOver
            ? 'Remove attachments over the limit'
            : hasPrompt
              ? undefined
              : 'Type a message first';

  function submit(): void {
    if (disabledReason !== undefined) {
      return;
    }

    const text = prompt.trim();
    const taken = attachments.take();
    setPrompt('');
    // A refused message is not lost: its text comes back, unless something new was typed
    // meanwhile, and so do its files.
    onSubmit(
      text,
      taken.flatMap((item) => (item.attachment === undefined ? [] : [item.attachment])),
    ).then(
      () => {
        attachments.release(taken);
      },
      () => {
        setPrompt((current) => (current === '' ? text : current));
        attachments.restore(taken);
      },
    );
  }

  return (
    <div className="shrink-0 px-3.5 pt-3 pb-3.5">
      {needsConnection ? <ConnectToPay className="mb-2.5" /> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onDragEnter={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          dragDepth.current += 1;
          setIsDragging(true);
        }}
        onDragOver={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(event) => {
          if (!hasFiles(event)) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setIsDragging(false);
        }}
        onDrop={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          dragDepth.current = 0;
          setIsDragging(false);
          attachments.add(event.dataTransfer.files);
        }}
        className={cn(
          'bg-raised border-line relative flex flex-col gap-[11px] rounded-xl border pt-3 pr-2.5 pb-2.5 pl-[13px]',
          'focus-within:border-brand-border transition-colors',
          isDragging && 'border-brand-border',
        )}
      >
        {isDragging ? (
          <div
            aria-hidden="true"
            className={cn(
              'bg-brand-soft/90 border-brand-border text-brand-text text-label-sm pointer-events-none',
              'absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-xl border-2',
              'border-dashed font-medium',
            )}
          >
            <PaperclipIcon className="size-4" />
            Drop files to attach
          </div>
        ) : null}

        <PendingAttachmentStrip
          items={attachments.items}
          onRemove={attachments.remove}
          onRetry={attachments.retry}
        />
        {attachments.notice === undefined ? null : (
          <p role="status" className="text-caption text-danger">
            {attachments.notice}
          </p>
        )}

        <label htmlFor={id} className="sr-only">
          {isAnswering ? 'Answer the run' : 'Ask BAIOS for a change to this project'}
        </label>
        <textarea
          id={id}
          rows={1}
          value={prompt}
          placeholder={isAnswering ? 'Answer the question above' : placeholder}
          className={cn(
            'text-body-sm text-foreground placeholder:text-faint field-sizing-content',
            'max-h-40 w-full resize-none bg-transparent outline-none',
          )}
          onChange={(event) => {
            setPrompt(event.target.value);
          }}
          onPaste={(event) => {
            // Files only; a plain text paste is left to the browser.
            const files = [...event.clipboardData.files];
            if (files.length === 0) return;
            event.preventDefault();
            attachments.add(files);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />

        <div className="flex min-w-0 items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            data-testid="attach-input"
            onChange={(event) => {
              attachments.add(event.target.files ?? []);
              // The same file can be picked again after it was removed.
              event.target.value = '';
            }}
          />
          <button
            type="button"
            aria-label="Attach files"
            title={
              attachments.isFull
                ? 'This message already carries as many files as it can'
                : 'Attach files'
            }
            disabled={attachments.isFull}
            // Keeps focus in the text box.
            onPointerDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => fileInput.current?.click()}
            className={cn(
              'text-subdued hover:bg-muted hover:text-foreground flex size-8 shrink-0 items-center',
              'justify-center rounded-full transition-colors disabled:opacity-40',
              'disabled:hover:bg-transparent',
            )}
          >
            <PaperclipIcon className="size-4" aria-hidden="true" />
          </button>

          <ModelPicker state={modelState} className="max-w-[200px]" />

          <span className="flex-1" />

          <ComposerPrimaryAction
            disabledReason={disabledReason}
            // A waiting run is answered, so it offers Send rather than Stop.
            isRunning={isRunning && !isAnswering}
            isStopping={isStopping}
            label={isAnswering ? 'Send answer' : 'Send'}
            onStop={onStop}
          />
        </div>
      </form>
    </div>
  );
}
