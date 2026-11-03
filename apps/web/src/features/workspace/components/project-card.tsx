import { Link } from 'react-router-dom';

import { projectPath } from '@/lib/routes';
import type { Project } from '../types';

interface ProjectCardProps {
  project: Project;
}

/**
 * One project on the shelf: preview artwork, name, and when it was created.
 *
 * ## Two controls that used to be here, and why they are not
 *
 * `ProjectSummary` is `{id, name, createdAt}` and nothing else. §11's reasoning for that is worth
 * reading — a preview label is a capability rather than a description, and even the workspace id is
 * withheld so a guest learns no organisation structure from a listing they are entitled to.
 *
 * So there is no build status to chip and no starred flag to fill. Both were rendered from mock
 * data. A status that always read "ready" would describe nothing, and a star that forgot itself on
 * reload would be a control that lies about having worked — worse than its absence, because a user
 * would learn to distrust the ones that do work. They return when a project has a lifecycle to
 * report and somewhere to record a preference.
 */
export function ProjectCard({ project }: ProjectCardProps): React.JSX.Element {
  return (
    <article className="bg-raised border-line-subtle relative overflow-hidden rounded-xl border">
      <div
        aria-hidden="true"
        className="h-[104px] bg-[linear-gradient(152.9deg,var(--color-thumb-from)_0%,var(--color-thumb-to)_71.429%)]"
      />
      <div className="flex flex-col gap-2 pt-[11px] pr-[11px] pb-3 pl-3">
        <h3 className="text-label-sm text-foreground min-w-0 font-medium">
          {/* Stretched so the whole card opens the project. */}
          <Link
            to={projectPath(project.id)}
            className="after:absolute after:inset-0 after:content-['']"
          >
            {project.name}
          </Link>
        </h3>
        <p className="text-caption text-faint min-w-0 truncate">{project.activity}</p>
      </div>
    </article>
  );
}
