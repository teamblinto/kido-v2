import { useId } from 'react';
import { Link } from 'react-router-dom';

import { routes } from '@/lib/routes';
import { cn } from '@/lib/utils';
import { type PayWithChoice, SUBSCRIPTION_MODELS } from '../lib/pay-with';

const fieldClass = cn(
  'border-line-subtle bg-canvas text-label-xs text-foreground h-7 w-full min-w-0 rounded-md border px-1.5',
);

const MODEL_LABEL: Record<(typeof SUBSCRIPTION_MODELS)[number], string> = {
  haiku: 'Haiku',
  opus: 'Opus',
  sonnet: 'Sonnet',
};

/**
 * Who pays for the next run (spec 041): BAIOS, or the person's own Claude plan once it is
 * connected in Settings. `unavailable` says why the plan cannot be used right now.
 */
export function PayWithPicker({
  choice,
  onChange,
  unavailable,
}: {
  readonly choice: PayWithChoice;
  readonly onChange: (choice: PayWithChoice) => void;
  readonly unavailable: string | undefined;
}): React.JSX.Element {
  const id = useId();
  const onPlan = choice.payWith === 'subscription';

  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="sr-only">Who pays for this run</legend>
      <div className="grid grid-cols-2 gap-1.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <label htmlFor={`${id}-pay`} className="text-label-xs text-faint font-medium">
            Pay with
          </label>
          <select
            id={`${id}-pay`}
            className={fieldClass}
            value={choice.payWith}
            onChange={(event) => {
              onChange({ ...choice, payWith: event.target.value as PayWithChoice['payWith'] });
            }}
          >
            <option value="baios">BAIOS</option>
            <option value="subscription" disabled={unavailable !== undefined && !onPlan}>
              My Claude subscription{unavailable === undefined ? '' : ' (not connected)'}
            </option>
          </select>
        </div>

        {onPlan ? (
          <div className="flex min-w-0 flex-col gap-0.5">
            <label htmlFor={`${id}-model`} className="text-label-xs text-faint font-medium">
              Model
            </label>
            <select
              id={`${id}-model`}
              className={fieldClass}
              value={choice.model ?? ''}
              onChange={(event) => {
                const model = SUBSCRIPTION_MODELS.find((m) => m === event.target.value) ?? null;
                onChange({ ...choice, model });
              }}
            >
              <option value="">Default</option>
              {SUBSCRIPTION_MODELS.map((m) => (
                <option key={m} value={m}>
                  {MODEL_LABEL[m]}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {unavailable === undefined ? null : (
        <p className={cn('text-caption', onPlan ? 'text-warning' : 'text-faint')} role="status">
          {unavailable}{' '}
          <Link
            to={`${routes.accountSettings}#claude-subscription`}
            className="text-brand-text underline-offset-4 hover:underline"
          >
            Open Settings
          </Link>
        </p>
      )}
    </fieldset>
  );
}
