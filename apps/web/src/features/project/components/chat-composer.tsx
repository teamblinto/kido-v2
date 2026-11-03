import { ArrowUpIcon, PaperclipIcon, SquareIcon } from 'lucide-react';
import { useId, useState } from 'react';

import { useSubscriptions } from '@/features/settings/subscription/subscription-api';
import { cn } from '@/lib/utils';
import {
  type SubscriptionRunRequest,
  readPayWith,
  toRunRequest,
  writePayWith,
} from '../lib/pay-with';
import { PayWithPicker } from './pay-with-picker';

interface ChatComposerProps {
  /** While a run is going the send button becomes Stop, as in the design. */
  isRunning: boolean;
  /**
   * Whether a stop has been asked for and the run has not yet stopped.
   *
   * Its own state rather than the absence of `isRunning`, because that gap is the point: the API
   * records the request and answers at once, and the run ends when it ends (FR-012, SC-005).
   */
  isStopping: boolean;
  /**
   * The model the run reports, shown as a label.
   *
   * Deliberately not a picker (FR-018, FR-020): the API chooses the model and reports which one
   * it used, so offering a choice here would be offering something nothing can honour. Absent
   * until a run exists to report one.
   */
  model?: string;
  onStop: () => void;
  /** `target` is set when the run is paid with the person's own Claude plan (spec 041). */
  onSubmit: (prompt: string, target?: SubscriptionRunRequest) => void;
  placeholder: string;
  /** The project the "Pay with" choice is remembered for. */
  projectId?: string;
}

/** The box at the foot of the chat: queue another instruction, or stop this one. */
export function ChatComposer({
  isRunning,
  isStopping,
  model,
  onStop,
  onSubmit,
  placeholder,
  projectId,
}: ChatComposerProps): React.JSX.Element {
  const id = useId();
  const [prompt, setPrompt] = useState('');
  const [choice, setChoice] = useState(() => readPayWith(projectId));
  const subscriptions = useSubscriptions();
  const state = subscriptions.data?.claude.state;
  const unavailable =
    state === 'connected'
      ? undefined
      : state === undefined && !subscriptions.isError
        ? 'Checking your Claude subscription…'
        : 'Connect your Claude subscription in Settings to pay with your own plan.';
  const request = toRunRequest(choice);

  // A remembered plan that is no longer connected says why under the picker; sending would only
  // be refused.
  const canSubmit =
    prompt.trim().length > 0 && (request === undefined || unavailable === undefined);

  function submit(): void {
    if (!canSubmit) {
      return;
    }

    if (request === undefined) onSubmit(prompt.trim());
    else onSubmit(prompt.trim(), request);
    setPrompt('');
  }

  return (
    <div className="shrink-0 px-3.5 pt-3 pb-3.5">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="bg-raised border-line flex flex-col gap-[11px] rounded-xl border pt-3 pr-2.5 pb-2.5 pl-[13px]"
      >
        <PayWithPicker
          choice={choice}
          onChange={(next) => {
            setChoice(next);
            writePayWith(projectId, next);
          }}
          unavailable={unavailable}
        />

        <label htmlFor={id} className="sr-only">
          Ask BAIOS for a change to this project
        </label>
        <textarea
          id={id}
          rows={1}
          value={prompt}
          placeholder={placeholder}
          className={cn(
            'text-body-sm text-foreground placeholder:text-faint field-sizing-content',
            'max-h-40 w-full resize-none bg-transparent outline-none',
          )}
          onChange={(event) => {
            setPrompt(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-faint hover:text-subdued rounded-sm transition-colors"
          >
            <PaperclipIcon className="size-[15px]" aria-hidden="true" />
            <span className="sr-only">Attach a file</span>
          </button>

          {model === undefined ? null : (
            <span className="text-label-xs text-faint font-medium">{model}</span>
          )}

          <span className="flex-1" />

          {isRunning ? (
            <button
              type="button"
              onClick={onStop}
              // Asked for already: the control says so and stops taking the request again. It is
              // not hidden — the run is still going, and a control that vanished would read as
              // the run having ended.
              disabled={isStopping}
              className={cn(
                'bg-danger-soft text-danger text-label-sm hover:bg-danger-soft/70 flex items-center',
                'gap-1.5 rounded-md px-[11px] py-[7px] font-medium transition-colors',
                'disabled:hover:bg-danger-soft disabled:opacity-60',
              )}
            >
              <SquareIcon className="size-3 fill-current" aria-hidden="true" />
              {isStopping ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSubmit}
              className={cn(
                'bg-primary text-primary-foreground hover:bg-primary/90 flex size-7 shrink-0',
                'items-center justify-center rounded-full transition-opacity disabled:opacity-35',
              )}
            >
              <ArrowUpIcon className="size-3.5" aria-hidden="true" />
              <span className="sr-only">Send</span>
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
