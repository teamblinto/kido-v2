import type { CatalogueTemplate, ProjectTemplate } from '@repo/contracts';

import { cn } from '@/lib/utils';
import type { ModelChoiceState } from '../hooks/use-model-choice';
import { PromptComposer } from './prompt-composer';

interface WorkspaceHeroProps {
  /** The composer's error slot: why the last prompt did not become a project. */
  error?: string;
  /** A workspace with no projects yet gets the first-run greeting, and the
   * hero stretches to fill the page rather than sitting above a full shelf. */
  isFirstRun: boolean;
  /** The model picker's state; its choice is who pays for the first run (spec 043). */
  modelState: ModelChoiceState;
  name: string;
  /** Nothing can pay for a run: the composer offers to connect instead of sending. */
  needsConnection?: boolean;
  onSelectTemplate: (template: ProjectTemplate) => void;
  onSubmitPrompt: (prompt: string, options?: { credential?: 'organisation' }) => void;
  /** Spec 032 US7: see `PromptComposer`'s prop of the same name. */
  personalAccountsOff?: boolean;
  suggestions: readonly string[];
  templateId: ProjectTemplate | undefined;
  templates: readonly CatalogueTemplate[];
}

/** The greeting and prompt composer at the top of the workspace home screen. */
export function WorkspaceHero({
  error,
  isFirstRun,
  modelState,
  name,
  needsConnection,
  onSelectTemplate,
  onSubmitPrompt,
  personalAccountsOff,
  suggestions,
  templateId,
  templates,
}: WorkspaceHeroProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center bg-linear-to-b from-[#fbfcfc] to-[#e7f2ef]',
        'px-5 py-16 text-center sm:px-8',
        isFirstRun ? 'flex-1' : 'min-h-[430px]',
      )}
    >
      <h1 className="text-display-sm text-foreground font-semibold text-balance">
        {isFirstRun ? `What should we build, ${name}?` : `Welcome back, ${name}`}
      </h1>
      <p className="text-body-md text-subdued mt-2.5 max-w-xl text-pretty">
        Describe it in a sentence — BAIOS scaffolds the project, runs it, and shows you a preview.
      </p>
      <div className="mt-[26px] w-full max-w-[680px] text-left">
        <PromptComposer
          error={error}
          modelState={modelState}
          needsConnection={needsConnection}
          personalAccountsOff={personalAccountsOff}
          suggestions={suggestions}
          templateId={templateId}
          templates={templates}
          onSelectTemplate={onSelectTemplate}
          onSubmit={onSubmitPrompt}
        />
      </div>
    </div>
  );
}
