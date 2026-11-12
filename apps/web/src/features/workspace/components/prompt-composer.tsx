import type { CatalogueModel, CatalogueTemplate, ProjectTemplate } from '@repo/contracts';
import { ArrowUpIcon, ChevronDownIcon, LayoutGridIcon } from 'lucide-react';
import { useId, useRef, useState } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSection,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  limitOfModel,
  limitSentence,
  RUN_ON_ORGANISATION,
} from '@/features/settings/subscription-limit';
import { cn } from '@/lib/utils';
import type { ModelChoiceState } from '../hooks/use-model-choice';
import { type ModelChoice, catalogueEntry } from '../lib/model-choice';
import { CONNECT_TO_SEND, ComposerPrimaryAction, ConnectToPay } from './composer-parts';
import { ModelPicker } from './model-picker';

interface PromptComposerProps {
  /** Why the last submission was refused, shown under the input until the next one. */
  error?: string;
  /** The model picker's sources and choice (spec 043): the payment choice for the first run. */
  modelState: ModelChoiceState;
  /** Nothing can pay for a run: the connect path shows instead of sending. */
  needsConnection?: boolean;
  onSelectTemplate: (template: ProjectTemplate) => void;
  /** `credential: 'organisation'` only from the limit's own button (spec 032 A3). */
  onSubmit: (prompt: string, options?: { credential?: 'organisation' }) => void;
  /**
   * Spec 032 US7: the organisation forbids members' personal subscriptions and the caller has one
   * linked for the selected model's provider — said once under the composer.
   */
  personalAccountsOff?: boolean;
  suggestions: readonly string[];
  /** The template on the chip. Undefined until the catalogue has named its default. */
  templateId: ProjectTemplate | undefined;
  /** What `GET /templates` lists (spec 015). The only source of template ids on the web. */
  templates: readonly CatalogueTemplate[];
}

/**
 * The "describe your tool" input that anchors the workspace home screen. The starter prompts only
 * appear once it is engaged, keeping the resting state calm; the model picker is always there,
 * because it is also who pays.
 */
export function PromptComposer({
  error,
  modelState,
  needsConnection = false,
  onSelectTemplate,
  onSubmit,
  personalAccountsOff = false,
  suggestions,
  templateId,
  templates,
}: PromptComposerProps): React.JSX.Element {
  const id = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isTemplateMenuOpen, setIsTemplateMenuOpen] = useState(false);

  // A menu takes focus out of the textarea, so it has to count as engagement in its own right or
  // the starter prompts would unmount under it.
  const isEngaged = isFocused || isModelMenuOpen || isTemplateMenuOpen || prompt.length > 0;
  // Spec 032 T048: a limited subscription never runs elsewhere without the person's say-so.
  const limit = limitOfModel(catalogueEntry(modelState.choice, modelState.catalogue.data));
  const hasPrompt = prompt.trim().length > 0;
  const disabledReason = needsConnection
    ? CONNECT_TO_SEND
    : !hasPrompt
      ? 'Describe what to build first'
      : limit === undefined
        ? undefined
        : limitSentence(limit);

  function submit(options?: { credential: 'organisation' }): void {
    if (!hasPrompt || needsConnection || (limit !== undefined && options === undefined)) {
      return;
    }

    if (options === undefined) {
      onSubmit(prompt.trim());
    } else {
      onSubmit(prompt.trim(), options);
    }
    setPrompt('');
  }

  function applySuggestion(suggestion: string): void {
    setPrompt(`A tool for ${suggestion.toLowerCase()}`);
    textareaRef.current?.focus();
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className={cn(
          'bg-raised shadow-composer flex w-full flex-col gap-3.5 rounded-2xl border-[1.6px]',
          'pt-[15px] pr-3 pb-3 pl-4 transition-colors',
          isEngaged ? 'border-brand' : 'border-line-subtle',
        )}
      >
        <label htmlFor={id} className="sr-only">
          Describe the internal tool you want to build
        </label>
        <textarea
          id={id}
          name="prompt"
          ref={textareaRef}
          rows={1}
          value={prompt}
          placeholder="Ask BAIOS to create an internal tool that…"
          className={cn(
            'text-body-lg text-foreground placeholder:text-faint field-sizing-content',
            'max-h-40 w-full resize-none bg-transparent outline-none',
          )}
          onChange={(event) => {
            setPrompt(event.target.value);
          }}
          onFocus={() => {
            setIsFocused(true);
          }}
          onBlur={() => {
            setIsFocused(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />

        <div
          className="flex flex-wrap items-center gap-2"
          // Toolbar buttons must not steal focus from the prompt the user is
          // mid-way through writing.
          onMouseDown={(event) => {
            event.preventDefault();
          }}
        >
          <ModelPicker state={modelState} onOpenChange={setIsModelMenuOpen} />
          <TemplatePicker
            isMenuOpen={isTemplateMenuOpen}
            templateId={templateId}
            templates={templates}
            onMenuOpenChange={setIsTemplateMenuOpen}
            onSelectTemplate={onSelectTemplate}
          />
          <span className="flex-1" />
          <ComposerPrimaryAction disabledReason={disabledReason} label="Send prompt" />
        </div>
      </form>

      {needsConnection ? <ConnectToPay className="w-full" /> : null}

      <PreflightLine
        choice={modelState.choice}
        entry={catalogueEntry(modelState.choice, modelState.catalogue.data)}
        personalAccountsOff={personalAccountsOff}
      />

      {limit === undefined ? null : (
        <div role="status" className="text-body-sm text-subdued flex flex-col items-center gap-1.5">
          <p>{limitSentence(limit)}</p>
          {limit.alternativeMode === undefined ? null : (
            <button
              type="button"
              disabled={!hasPrompt}
              className="text-label-xs text-brand-text font-medium underline underline-offset-2 disabled:opacity-50"
              onClick={() => {
                submit({ credential: 'organisation' });
              }}
            >
              {RUN_ON_ORGANISATION}
            </button>
          )}
        </div>
      )}

      {error === undefined ? null : (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      )}

      {isEngaged && suggestions.length > 0 ? (
        <ul aria-label="Starter prompts" className="flex flex-wrap justify-center gap-2">
          {suggestions.map((suggestion) => (
            <li key={suggestion}>
              <button
                type="button"
                // Blur fires before click, so commit the suggestion on mousedown
                // instead — otherwise the row unmounts out from under the press.
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  applySuggestion(suggestion);
                }}
                className={cn(
                  'bg-raised border-line text-label-xs text-subdued hover:bg-subtle flex items-center',
                  'gap-1.5 rounded-full border px-3 py-[7px] font-medium transition-colors',
                )}
              >
                <ArrowUpIcon className="size-3" aria-hidden="true" />
                {suggestion}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Whose credential a run would use (spec 032 FR-014's disclosure). */
function PreflightLine({
  choice,
  entry,
  personalAccountsOff,
}: {
  choice: ModelChoice | undefined;
  /** The catalogue entry a catalogue choice names; a BYOS one is the caller's linked account. */
  entry: CatalogueModel | undefined;
  personalAccountsOff: boolean;
}): React.JSX.Element | null {
  if (choice === undefined) return null;
  const personal = choice.source === 'subscription' || entry?.credentialMode === 'BYOS';
  const provider = entry?.provider === 'openai' ? 'OpenAI' : 'Claude';

  return (
    <div className="text-caption text-subdued flex flex-col items-center gap-0.5">
      <p data-testid="credential-preflight">
        {personal ? `Runs on your ${provider} subscription` : "Runs on the organisation's key"}
      </p>
      {personalAccountsOff && !personal ? (
        <p>Personal subscriptions are turned off in this organisation.</p>
      ) : null}
    </div>
  );
}

/** Why an unready template cannot be picked — the one phrase spec 015 gives for it. */
const NOT_READY = 'Not ready to serve yet';

function TemplatePicker({
  isMenuOpen,
  onMenuOpenChange,
  onSelectTemplate,
  templateId,
  templates,
}: Pick<PromptComposerProps, 'onSelectTemplate' | 'templateId' | 'templates'> & {
  isMenuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const selected = templates.find((template) => template.id === templateId);

  return (
    <DropdownMenu open={isMenuOpen} onOpenChange={onMenuOpenChange}>
      <DropdownMenuTrigger
        className={cn(
          'bg-muted text-label-xs text-subdued hover:bg-secondary flex items-center gap-1.5',
          'rounded-lg py-1.5 pr-2.5 pl-[9px] font-medium transition-colors',
        )}
      >
        <LayoutGridIcon className="size-[13px]" aria-hidden="true" />
        {selected?.name ?? 'Template'}
        <ChevronDownIcon className="size-3" aria-hidden="true" />
        <span className="sr-only">Change template</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[280px]">
        <DropdownMenuSection aria-label="Templates">
          <DropdownMenuLabel>Template</DropdownMenuLabel>
          {templates.map((template) => (
            <DropdownMenuItem
              key={template.id}
              // `aria-disabled` rather than Radix's `disabled`: a disabled item drops out of the
              // menu's roving focus, so a keyboard or screen-reader user would never reach the
              // one entry whose whole purpose is to explain why it is not pickable.
              aria-disabled={!template.ready}
              className={cn(
                'py-2.5',
                template.id === selected?.id && 'bg-brand-soft',
                !template.ready && 'opacity-50',
              )}
              onSelect={(event) => {
                if (!template.ready) {
                  event.preventDefault();

                  return;
                }

                onSelectTemplate(template.id);
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block">{template.name}</span>
                <span className="text-caption text-faint block font-normal">
                  {template.ready ? template.description : NOT_READY}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuSection>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
