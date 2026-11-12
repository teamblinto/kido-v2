import { useId, useState } from 'react';

import {
  CONNECT_TO_SEND,
  ComposerPrimaryAction,
  ConnectToPay,
} from '@/features/workspace/components/composer-parts';
import { ModelPicker } from '@/features/workspace/components/model-picker';
import type { ModelChoiceState } from '@/features/workspace/hooks/use-model-choice';
import { cn } from '@/lib/utils';

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
  /** Resolves once the message was accepted; a refusal hands the text back to the box. */
  onSubmit: (prompt: string) => Promise<unknown>;
  placeholder: string;
}

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
  placeholder,
}: ChatComposerProps): React.JSX.Element {
  const id = useId();
  const [prompt, setPrompt] = useState('');
  const hasPrompt = prompt.trim().length > 0;
  const disabledReason = needsConnection
    ? CONNECT_TO_SEND
    : isSending
      ? 'Sending…'
      : hasPrompt
        ? undefined
        : 'Type a message first';

  function submit(): void {
    if (disabledReason !== undefined) {
      return;
    }

    const text = prompt.trim();
    setPrompt('');
    // A refused message is not lost: it comes back, unless something new was typed meanwhile.
    onSubmit(text).catch(() => {
      setPrompt((current) => (current === '' ? text : current));
    });
  }

  return (
    <div className="shrink-0 px-3.5 pt-3 pb-3.5">
      {needsConnection ? <ConnectToPay className="mb-2.5" /> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className={cn(
          'bg-raised border-line flex flex-col gap-[11px] rounded-xl border pt-3 pr-2.5 pb-2.5 pl-[13px]',
          'focus-within:border-brand-border transition-colors',
        )}
      >
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
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />

        <div className="flex min-w-0 items-center gap-2">
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
