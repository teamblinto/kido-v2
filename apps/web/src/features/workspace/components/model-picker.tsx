import {
  CheckIcon,
  ChevronDownIcon,
  KeyRoundIcon,
  PlugIcon,
  RotateCwIcon,
  SearchIcon,
  SparklesIcon,
} from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Kbd } from '@/components/ui/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { metaShortcutLabel } from '@/hooks/use-meta-shortcut';
import { routes } from '@/lib/routes';
import { cn } from '@/lib/utils';
import type { ModelChoiceState } from '../hooks/use-model-choice';
import { type ModelChoice, choiceLabel, rankByQuery, sameChoice } from '../lib/model-choice';

/** Where a person connects their Claude subscription (spec 041's card). */
export const CONNECT_SUBSCRIPTION_PATH = `${routes.accountSettings}#claude-subscription`;

interface Entry {
  readonly badge?: string;
  readonly choice?: ModelChoice;
  readonly description: string | null;
  /** Why the entry cannot be picked; it stays listed so the reason can be read. */
  readonly disabledReason?: string;
  readonly fields: readonly string[];
  readonly key: string;
  readonly kind: 'connect' | 'model';
  readonly label: string;
}

/** Mod+Shift+M, wherever focus is. */
function isShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'm';
}

function subscriptionEntries(state: ModelChoiceState): Entry[] {
  const claude = state.subscriptions.data?.claude;
  if (claude === undefined) return [];
  if (claude.state !== 'connected') {
    return [
      {
        description: 'Run on your own Claude plan',
        fields: [],
        key: 'connect',
        kind: 'connect',
        label: 'Connect your Claude subscription',
      },
    ];
  }

  return (claude.models ?? []).map((model) => ({
    choice: { model: model.id, source: 'subscription' },
    description: model.description,
    fields: [model.label, model.id],
    key: `s:${model.id}`,
    kind: 'model',
    label: model.label,
  }));
}

function catalogueEntries(state: ModelChoiceState): Entry[] {
  return (state.catalogue.data?.models ?? []).map((model) => ({
    ...(model.credentialMode === 'BYOS' ? { badge: 'linked account' } : {}),
    choice: { model: model.id, source: 'catalogue' },
    description: model.description,
    ...(model.available
      ? {}
      : {
          disabledReason:
            model.unavailableReason === 'subscription-needs-reauth'
              ? 'Reconnect your account in Settings'
              : "The organisation's key needs replacing in Settings",
        }),
    fields: [model.name, model.shortName, model.id],
    key: `c:${model.id}`,
    kind: 'model',
    label: model.name,
  }));
}

/**
 * The one model picker (spec 043): the person's Claude subscription and the organisation's API
 * keys, searchable, keyboard-driven, opened by Mod+Shift+M. The choice is the payment choice, and
 * it applies to the next message — switching mid-conversation is always allowed. It never blocks
 * the composer: while the reads are out, the chip reads "Model" and the list says it is loading.
 */
export function ModelPicker({
  className,
  onOpenChange,
  state,
}: {
  readonly className?: string;
  readonly onOpenChange?: (open: boolean) => void;
  readonly state: ModelChoiceState;
}): React.JSX.Element {
  const id = useId();
  const navigate = useNavigate();
  const [open, setOpenState] = useState(false);
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string | undefined>(undefined);
  const sources = { catalogue: state.catalogue.data, subscriptions: state.subscriptions.data };
  const label = choiceLabel(state.choice, sources);

  function setOpen(next: boolean): void {
    setOpenState(next);
    onOpenChange?.(next);
    if (next) {
      setQuery('');
      setActiveKey(undefined);
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!isShortcut(event)) return;
      event.preventDefault();
      setOpenState(true);
      onOpenChange?.(true);
      setQuery('');
      setActiveKey(undefined);
    }

    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onOpenChange]);

  const fields = (entry: Entry): readonly string[] => entry.fields;
  const allSubscription = subscriptionEntries(state);
  const subscription = [
    ...allSubscription.filter((entry) => entry.kind === 'connect'),
    ...rankByQuery(
      allSubscription.filter((entry) => entry.kind === 'model'),
      query,
      fields,
    ),
  ];
  const allCatalogue = catalogueEntries(state);
  const catalogue = rankByQuery(allCatalogue, query, fields);
  const pickable = [...subscription, ...catalogue].filter(
    (entry) => entry.disabledReason === undefined,
  );
  const selectedKey = pickable.find(
    (entry) => entry.choice !== undefined && sameChoice(entry.choice, state.choice),
  )?.key;
  // With a query the best match leads; without one, the current choice does.
  const active =
    pickable.find((entry) => entry.key === activeKey) ??
    (query.trim() === '' ? pickable.find((entry) => entry.key === selectedKey) : undefined) ??
    pickable[0];
  const optionId = (entry: Entry): string => `${id}-option-${entry.key}`;

  useEffect(() => {
    if (!open || active === undefined) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
    // optionId is derived from `id` and the entry key, both covered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active?.key]);

  function activate(entry: Entry): void {
    if (entry.disabledReason !== undefined) return;
    setOpen(false);
    if (entry.kind === 'connect') {
      void navigate(CONNECT_SUBSCRIPTION_PATH);
    } else if (entry.choice !== undefined) {
      state.setChoice(entry.choice);
    }
  }

  function move(step: number): void {
    if (pickable.length === 0) return;
    const at = active === undefined ? -1 : pickable.indexOf(active);
    const next = pickable[(at + step + pickable.length) % pickable.length];
    setActiveKey(next?.key);
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') move(1);
    else if (event.key === 'ArrowUp') move(-1);
    else if (event.key === 'Home') setActiveKey(pickable[0]?.key);
    else if (event.key === 'End') setActiveKey(pickable.at(-1)?.key);
    else if (event.key === 'Enter') {
      if (active !== undefined) activate(active);
    } else return;
    event.preventDefault();
  }

  const claude = state.subscriptions.data?.claude;
  const reportsNoModels =
    claude?.state === 'connected' && (claude.models === null || claude.models.length === 0);
  const noMatches = query.trim() !== '' && pickable.length === 0;

  function renderEntry(entry: Entry): React.JSX.Element {
    const isActive = entry.key === active?.key;
    const isSelected = entry.key === selectedKey;
    const Icon = entry.kind === 'connect' ? PlugIcon : undefined;

    return (
      <div
        key={entry.key}
        id={optionId(entry)}
        role="option"
        aria-labelledby={`${optionId(entry)}-label`}
        aria-describedby={
          (entry.disabledReason ?? entry.description) === null
            ? undefined
            : `${optionId(entry)}-description`
        }
        aria-selected={isSelected}
        aria-disabled={entry.disabledReason === undefined ? undefined : true}
        data-active={isActive ? '' : undefined}
        onMouseMove={() => {
          if (entry.disabledReason === undefined && !isActive) setActiveKey(entry.key);
        }}
        onClick={() => {
          activate(entry);
        }}
        className={cn(
          'flex cursor-default items-start gap-2 rounded-lg px-2.5 py-2 text-left select-none',
          'transition-colors duration-100',
          isActive && 'bg-muted',
          entry.disabledReason !== undefined && 'opacity-50',
        )}
      >
        {Icon === undefined ? null : (
          <Icon className="text-brand-text mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1">
          <span
            id={`${optionId(entry)}-label`}
            className="text-label-sm text-foreground block font-medium"
          >
            {entry.label}
          </span>
          {(entry.disabledReason ?? entry.description) === null ? null : (
            <span id={`${optionId(entry)}-description`} className="text-caption text-faint block">
              {entry.disabledReason ?? entry.description}
            </span>
          )}
        </span>
        {entry.badge === undefined ? null : (
          <span className="text-caption text-subdued border-line-subtle shrink-0 rounded-md border px-1.5">
            {entry.badge}
          </span>
        )}
        {isSelected ? (
          <CheckIcon className="text-brand-text mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        ) : null}
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-keyshortcuts="Control+Shift+M Meta+Shift+M"
        className={cn(
          'bg-brand-soft border-brand-border text-label-xs text-brand-text hover:bg-brand-soft/70',
          'flex min-w-0 items-center gap-1.5 rounded-lg border py-1.5 pr-2.5 pl-[9px] font-medium',
          'transition-[background-color,transform] active:scale-[0.97]',
          className,
        )}
      >
        {state.choice?.source === 'catalogue' ? (
          <KeyRoundIcon className="size-[13px] shrink-0" aria-hidden="true" />
        ) : (
          <SparklesIcon className="size-[13px] shrink-0" aria-hidden="true" />
        )}
        <span className="truncate">{label}</span>
        <ChevronDownIcon
          className="size-3 shrink-0 transition-transform duration-150 in-data-[state=open]:rotate-180"
          aria-hidden="true"
        />
        <span className="sr-only">, change model</span>
      </PopoverTrigger>
      <PopoverContent
        className="w-[300px] p-1.5"
        aria-label="Choose a model"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById(`${id}-search`)?.focus();
        }}
      >
        <div className="border-line-subtle mb-1 flex items-center gap-2 border-b px-2 pb-1.5">
          <SearchIcon className="text-faint size-3.5 shrink-0" aria-hidden="true" />
          <input
            id={`${id}-search`}
            role="combobox"
            aria-label="Search models"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={active === undefined ? undefined : optionId(active)}
            autoComplete="off"
            value={query}
            placeholder="Search models"
            className="text-body-sm placeholder:text-faint h-8 w-full bg-transparent outline-none"
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveKey(undefined);
            }}
            onKeyDown={onSearchKeyDown}
          />
        </div>

        <div
          id={`${id}-list`}
          role="listbox"
          aria-label="Models"
          className="flex max-h-80 flex-col gap-1 overflow-y-auto"
        >
          <div role="group" aria-labelledby={`${id}-subscription`} className="flex flex-col">
            <div
              id={`${id}-subscription`}
              role="presentation"
              className="text-caption text-faint px-2.5 pt-1.5 pb-1 font-medium"
            >
              Claude subscription
            </div>
            {state.subscriptions.isPending ? (
              <div
                role="presentation"
                aria-busy="true"
                className="flex flex-col gap-1.5 px-2.5 py-2"
              >
                <span className="sr-only">Checking your Claude subscription</span>
                <span className="bg-muted h-3 w-2/3 animate-pulse rounded" />
                <span className="bg-muted h-3 w-1/2 animate-pulse rounded" />
              </div>
            ) : null}
            {state.subscriptions.isError && claude === undefined ? (
              <SourceNote
                onRetry={() => void state.subscriptions.refetch()}
                text="Your Claude subscription could not be checked."
              />
            ) : null}
            {reportsNoModels ? (
              <SourceNote
                onRetry={() => void state.subscriptions.refetch()}
                text="Models appear once your subscription has checked in."
              />
            ) : null}
            {subscription.map(renderEntry)}
          </div>

          {allCatalogue.length === 0 ? null : (
            <div role="group" aria-labelledby={`${id}-keys`} className="flex flex-col">
              <div
                id={`${id}-keys`}
                role="presentation"
                className="text-caption text-faint px-2.5 pt-1.5 pb-1 font-medium"
              >
                API keys
              </div>
              {catalogue.map(renderEntry)}
            </div>
          )}

          {noMatches ? (
            <p role="presentation" className="text-caption text-faint px-2.5 py-2">
              No model matches “{query.trim()}”.
            </p>
          ) : null}
        </div>

        <p className="text-caption text-faint border-line-subtle mt-1 flex items-center gap-1 border-t px-2.5 pt-1.5">
          <span className="flex-1">Applies to your next message</span>
          <Kbd>{metaShortcutLabel('⇧M')}</Kbd>
        </p>
      </PopoverContent>
    </Popover>
  );
}

function SourceNote({
  onRetry,
  text,
}: {
  readonly onRetry: () => void;
  readonly text: string;
}): React.JSX.Element {
  return (
    <div role="presentation" className="flex items-center gap-2 px-2.5 py-2">
      <span className="text-caption text-subdued min-w-0 flex-1">{text}</span>
      <button
        type="button"
        onClick={onRetry}
        className="text-label-xs text-brand-text inline-flex shrink-0 items-center gap-1 font-medium active:scale-95"
      >
        <RotateCwIcon className="size-3" aria-hidden="true" />
        Retry
      </button>
    </div>
  );
}
