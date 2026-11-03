import { AlertTriangleIcon, ArrowRightIcon, PlusIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { messageFor } from '@/lib/api/problem';
import { cn } from '@/lib/utils';
import type { Project } from '../types';
import { ProjectCard } from './project-card';

const shelfTabs = [
  { label: 'Recently viewed', value: 'recent' },
  { label: 'My projects', value: 'mine' },
  { label: 'Shared with me', value: 'shared' },
  { label: 'Templates', value: 'templates' },
] as const;

type ShelfTab = (typeof shelfTabs)[number]['value'];

interface ProjectShelfProps {
  error?: unknown;
  isLoading?: boolean;
  onNewProject: () => void;
  onRetry?: () => void;
  projects: readonly Project[];
}

/** Project shelf pinned below the hero on the workspace home screen. */
export function ProjectShelf({
  error,
  isLoading = false,
  onNewProject,
  onRetry,
  projects,
}: ProjectShelfProps): React.JSX.Element {
  /*
   * `GET /orgs/:orgId/projects` returns the projects the caller may read, and nothing distinguishes
   * one tab from another in that answer: there is no "recently viewed" to sort by — `createdAt` is
   * the only timestamp — no ownership flag, and no templates. Rather than three tabs quietly
   * showing the same list, only the ones with an answer carry it.
   */
  const byTab: Record<ShelfTab, readonly Project[]> = {
    mine: projects,
    recent: projects,
    shared: [],
    templates: [],
  };

  return (
    <section
      aria-label="Projects"
      className="bg-canvas border-line-subtle border-t px-5 pt-[18px] pb-[22px] sm:px-7"
    >
      <Tabs defaultValue="recent" className="gap-3.5">
        <div className="flex items-center gap-5">
          <TabsList className="flex-1">
            {shelfTabs.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <a
            href="#"
            className={cn(
              'text-label-sm text-subdued hover:text-foreground flex shrink-0 items-center gap-1.5',
              'rounded-sm font-medium transition-colors max-sm:hidden',
            )}
          >
            Browse all
            <ArrowRightIcon className="size-3.5" aria-hidden="true" />
          </a>
        </div>

        {shelfTabs.map((tab) => (
          <TabsContent key={tab.value} value={tab.value}>
            {error === undefined || error === null ? (
              <ShelfGrid
                isLoading={isLoading}
                onNewProject={onNewProject}
                projects={byTab[tab.value]}
              />
            ) : (
              <ShelfError error={error} onRetry={onRetry} />
            )}
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}

/**
 * What the shelf shows when the listing failed.
 *
 * A retry rather than only a message, because most of what can go wrong here is transient — the
 * client already gave up on 4xx, so an error that reaches this component is usually a 5xx or an
 * unreachable service, and both are worth one more press.
 */
function ShelfError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}): React.JSX.Element {
  return (
    <div
      className="border-line-subtle flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center"
      role="alert"
    >
      <AlertTriangleIcon className="text-danger size-5" aria-hidden="true" />
      <div>
        <p className="text-label-sm text-foreground font-medium">
          {messageFor(error, 'We could not load your projects')}
        </p>
        <p className="text-caption text-faint mt-1">
          Nothing has been lost — this is only the list.
        </p>
      </div>
      {onRetry === undefined ? null : (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

interface ShelfGridProps {
  isLoading: boolean;
  onNewProject: () => void;
  projects: readonly Project[];
}

function ShelfGrid({ isLoading, onNewProject, projects }: ShelfGridProps): React.JSX.Element {
  const isEmpty = projects.length === 0;

  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      <li>
        <button
          type="button"
          onClick={onNewProject}
          className={cn(
            'bg-brand-soft border-brand-border hover:bg-brand-soft/70 flex w-full flex-col',
            'items-center justify-center gap-2 rounded-xl border border-dashed transition-colors',
            isEmpty && !isLoading ? 'h-[104px]' : 'h-[176px]',
          )}
        >
          <PlusIcon
            className={cn('text-brand', isEmpty && !isLoading ? 'size-5' : 'size-[22px]')}
            aria-hidden="true"
          />
          <span className="text-label-sm text-brand-text font-medium">New project</span>
        </button>
      </li>

      {isLoading ? (
        // Placeholders the same height as a card, so the shelf does not jump when the answer
        // arrives. Announced, because a screen reader has nothing else to go on here.
        <>
          <li className="sr-only" role="status">
            Loading your projects
          </li>
          {[0, 1, 2].map((slot) => (
            <li
              key={slot}
              aria-hidden="true"
              className="bg-subtle border-line-subtle h-[176px] animate-pulse rounded-xl border"
            />
          ))}
        </>
      ) : (
        projects.map((project) => (
          <li key={project.id}>
            <ProjectCard project={project} />
          </li>
        ))
      )}

      {isEmpty && !isLoading
        ? [0, 1, 2].map((slot) => (
            <li
              key={slot}
              aria-hidden="true"
              className="bg-subtle border-line-subtle h-[104px] rounded-xl border max-sm:hidden"
            />
          ))
        : null}
    </ul>
  );
}
