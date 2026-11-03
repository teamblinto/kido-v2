import type { CatalogueModel, CatalogueTemplate, ProjectTemplate } from '@repo/contracts';
import {
  ArrowUpIcon,
  ChevronDownIcon,
  LayoutGridIcon,
  type LucideIcon,
  MessageSquareIcon,
  MicIcon,
  PaperclipIcon,
  SparklesIcon,
} from 'lucide-react';
import { useId, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
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

interface PromptComposerProps {
  /** Why the last submission was refused, shown under the input until the next one. */
  error?: string;
  /** The model on the chip. An id `models` does not list — or none yet — reads as the first. */
  modelId: string | undefined;
  /** What the API reports a run may use (spec 011 US6). Empty until it has answered. */
  models: readonly CatalogueModel[];
  onSelectModel: (modelId: string) => void;
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
 * The "describe your tool" input that anchors the workspace home screen. It
 * expands once engaged: the model picker and the starter prompts only appear
 * when the composer is actually in use, keeping the resting state calm.
 */
export function PromptComposer({
  error,
  modelId,
  models,
  onSelectModel,
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

  // The model menu takes focus out of the textarea, so it has to count as
  // engagement in its own right or the row it lives in would unmount under it.
  const isEngaged = isFocused || isModelMenuOpen || isTemplateMenuOpen || prompt.length > 0;
  // Spec 032 T048: a limited subscription never runs elsewhere without the person's say-so.
  const limit = limitOfModel(findModel(models, modelId));
  const hasPrompt = prompt.trim().length > 0;
  const canSubmit = hasPrompt && limit === undefined;

  function submit(options?: { credential: 'organisation' }): void {
    if (!hasPrompt || (limit !== undefined && options === undefined)) {
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
          {isEngaged ? (
            <ModelPicker
              modelId={modelId}
              models={models}
              isMenuOpen={isModelMenuOpen}
              onMenuOpenChange={setIsModelMenuOpen}
              onSelectModel={onSelectModel}
            />
          ) : null}
          <ComposerChip icon={PaperclipIcon} label="Attach" />
          <TemplatePicker
            isMenuOpen={isTemplateMenuOpen}
            templateId={templateId}
            templates={templates}
            onMenuOpenChange={setIsTemplateMenuOpen}
            onSelectTemplate={onSelectTemplate}
          />
          <span className="flex-1" />
          <ComposerChip icon={MessageSquareIcon} label="Chat" className="max-sm:hidden" />
          <button
            type="button"
            className="text-faint hover:text-subdued rounded-sm p-1 transition-colors"
            aria-label="Dictate a prompt"
          >
            <MicIcon className="size-[17px]" aria-hidden="true" />
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className={cn(
              'bg-primary text-primary-foreground hover:bg-primary/90 flex size-8 shrink-0',
              'items-center justify-center rounded-full transition-opacity disabled:opacity-35',
            )}
          >
            <ArrowUpIcon className="size-[15px]" aria-hidden="true" />
            <span className="sr-only">Send prompt</span>
          </button>
        </div>
      </form>

      <PreflightLine model={findModel(models, modelId)} personalAccountsOff={personalAccountsOff} />

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

function findModel(
  models: readonly CatalogueModel[],
  modelId: string | undefined,
): CatalogueModel | undefined {
  return models.find((model) => model.id === modelId) ?? models[0];
}

/** How each provider reads on the chip and as a heading in the menu. */
const PROVIDER_LABEL: Record<CatalogueModel['provider'], string> = {
  anthropic: 'Claude',
  openai: 'OpenAI',
};

/** Whose credential a run would use, by `credentialMode` (spec 032 FR-014's disclosure). */
function preflightSentence(model: CatalogueModel): string {
  switch (model.credentialMode) {
    case 'BYOS':
      return `Runs on your ${PROVIDER_LABEL[model.provider]} subscription`;
    case 'BYOK':
      return "Runs on the organisation's key";
    case 'PLATFORM':
      return 'Runs on platform credits';
  }
}

/** Why a model cannot be picked: whose credential needs attention (spec 032). */
function unavailableSentence(model: CatalogueModel): string {
  return model.unavailableReason === 'subscription-needs-reauth'
    ? 'reconnect your account'
    : 'needs a new key';
}

function PreflightLine({
  model,
  personalAccountsOff,
}: {
  model: CatalogueModel | undefined;
  personalAccountsOff: boolean;
}): React.JSX.Element | null {
  if (model === undefined) return null;

  return (
    <div className="text-caption text-subdued flex flex-col items-center gap-0.5">
      <p data-testid="credential-preflight">{preflightSentence(model)}</p>
      {personalAccountsOff && model.credentialMode !== 'BYOS' ? (
        <p>Personal subscriptions are turned off in this organisation.</p>
      ) : null}
    </div>
  );
}

/** "Claude · Sonnet 5" — the chip label; a neutral "Model" until the catalogue has arrived. */
function describeModel(models: readonly CatalogueModel[], modelId: string | undefined): string {
  const model = findModel(models, modelId);

  return model === undefined ? 'Model' : `${PROVIDER_LABEL[model.provider]} · ${model.shortName}`;
}

/** The catalogue's providers in the order it lists them, each with its own models. */
function groupByProvider(
  models: readonly CatalogueModel[],
): [CatalogueModel['provider'], CatalogueModel[]][] {
  const groups = new Map<CatalogueModel['provider'], CatalogueModel[]>();

  for (const model of models) {
    groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
  }

  return [...groups];
}

function ModelPicker({
  isMenuOpen,
  modelId,
  models,
  onMenuOpenChange,
  onSelectModel,
}: Pick<PromptComposerProps, 'modelId' | 'models' | 'onSelectModel'> & {
  isMenuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const selected = findModel(models, modelId);

  return (
    <DropdownMenu open={isMenuOpen} onOpenChange={onMenuOpenChange}>
      <DropdownMenuTrigger
        className={cn(
          'bg-brand-soft border-brand-border text-label-xs text-brand-text hover:bg-brand-soft/70',
          'flex items-center gap-1.5 rounded-lg border py-1.5 pr-2.5 pl-[9px] font-medium transition-colors',
        )}
      >
        <SparklesIcon className="size-[13px]" aria-hidden="true" />
        {describeModel(models, modelId)}
        <ChevronDownIcon className="size-3" aria-hidden="true" />
        <span className="sr-only">Change model</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[280px]">
        {groupByProvider(models).map(([provider, group]) => (
          <DropdownMenuSection key={provider} aria-label={PROVIDER_LABEL[provider]}>
            <DropdownMenuLabel>{PROVIDER_LABEL[provider]}</DropdownMenuLabel>
            {group.map((model) => (
              <DropdownMenuItem
                key={model.id}
                // 020 US2: a `needs_reauth` key keeps the entry listed so the person sees why it
                // is not pickable, rather than wondering where the model went.
                disabled={!model.available}
                className={cn('py-2.5', model.id === selected?.id && 'bg-brand-soft')}
                onSelect={() => {
                  onSelectModel(model.id);
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block">{model.name}</span>
                  <span className="text-caption text-faint block font-normal">
                    {model.available ? model.description : unavailableSentence(model)}
                  </span>
                </span>
                {model.credentialMode === 'BYOK' ? <Badge variant="outline">your key</Badge> : null}
                {model.credentialMode === 'BYOS' ? (
                  <Badge variant="outline">your subscription</Badge>
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSection>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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

function ComposerChip({
  className,
  icon: Icon,
  label,
}: {
  className?: string;
  icon: LucideIcon;
  label: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'bg-muted text-label-xs text-subdued hover:bg-secondary flex items-center gap-1.5',
        'rounded-lg py-1.5 pr-2.5 pl-[9px] font-medium transition-colors',
        className,
      )}
    >
      <Icon className="size-[13px]" aria-hidden="true" />
      {label}
    </button>
  );
}
