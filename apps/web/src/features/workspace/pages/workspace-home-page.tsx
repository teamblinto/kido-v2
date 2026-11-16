import type { ProjectTemplate } from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { listLinkedAccounts } from '@/features/settings/linked-accounts-api';
import { getPersonalAccountsPolicy } from '@/features/settings/personal-accounts-policy-api';
import { SessionsDialog } from '@/features/auth/components/sessions-dialog';
import { TwoFactorDialog } from '@/features/auth/components/two-factor-dialog';
import { useSession } from '@/features/auth/session/session-context';
import { useNow } from '@/hooks/use-now';
import { ApiProblem, messageFor } from '@/lib/api/problem';
import { projectPath } from '@/lib/routes';
import { createProject, listMembers, listProjects, listWorkspaces } from '../api';
import { CommandPalette } from '../components/command-palette';
import { CreateOrgScreen } from '../components/create-org-screen';
import { ProjectCard } from '../components/project-card';
import { ProjectShelf } from '../components/project-shelf';
import { WorkspaceHero } from '../components/workspace-hero';
import { WorkspaceShell } from '../components/workspace-shell';
import { useCommandShortcut } from '../hooks/use-command-shortcut';
import { useModelChoice } from '../hooks/use-model-choice';
import { useOrgs } from '../hooks/use-orgs';
import type { Project as ProjectCardModel } from '../types';
import { useTemplates } from '../hooks/use-templates';
import { promptSuggestions } from '../lib/mock-data';
import { catalogueEntry } from '../lib/model-choice';
import { toProjectCard, toWorkspaceSummary } from '../lib/view-models';

/** Workspace home: the greeting, the composer, and everything already built. */
export function WorkspaceHomePage(): React.JSX.Element {
  const { user } = useSession();
  const { activeOrg, isEmpty, isGuest, isLoading: orgsLoading, orgs, selectOrg } = useOrgs();
  const orgId = activeOrg?.id;
  // Spec 031: a guest's organisation is asked for its projects and nothing else — members,
  // workspaces and models are the org's, and a guest is refused all three.
  const isMemberOrg = orgId !== undefined && !isGuest;

  const projects = useQuery({
    enabled: orgId !== undefined,
    queryFn: ({ signal }) => listProjects(orgId ?? '', signal),
    queryKey: ['projects', orgId],
  });

  const members = useQuery({
    enabled: isMemberOrg,
    queryFn: ({ signal }) => listMembers(orgId ?? '', signal),
    queryKey: ['members', orgId],
    // `org:members.read` is not held by every role, so a 403 here is an ordinary outcome for an
    // ordinary member rather than a fault. Retrying it would spend three requests learning the
    // same thing.
    retry: (failureCount, error) => !ApiProblem.is(error, 'permission-denied') && failureCount < 1,
  });

  // The composer creates into the organisation's first workspace: the one `OrgService.create`
  // made, and the only one until a workspace picker exists (spec 007, FR-018).
  const workspaceList = useQuery({
    enabled: isMemberOrg,
    queryFn: ({ signal }) => listWorkspaces(orgId ?? '', signal),
    queryKey: ['workspaces', orgId],
  });
  const workspaceId = workspaceList.data?.workspaces[0]?.id;

  // What the first run runs on, and so who pays (spec 043): the person's Claude subscription or a
  // catalogue entry. Held in memory here; the project remembers it once it exists.
  const modelState = useModelChoice({ enabled: isMemberOrg, orgId });
  const modelEntry = catalogueEntry(modelState.choice, modelState.catalogue.data);

  // Spec 032 US7: when the organisation forbids personal subscriptions, a member who has linked
  // one for the selected model's provider is told why the run will not use it.
  const policy = useQuery({
    enabled: isMemberOrg,
    queryFn: ({ signal }) => getPersonalAccountsPolicy(orgId ?? '', signal),
    queryKey: ['personal-accounts-policy', orgId],
  });
  const linkedAccounts = useQuery({
    enabled: isMemberOrg && policy.data?.allowed === false,
    queryFn: ({ signal }) => listLinkedAccounts(signal),
    queryKey: ['linked-accounts'],
  });
  const selectedProvider = modelEntry?.provider;
  const personalAccountsOff =
    policy.data?.allowed === false &&
    (linkedAccounts.data?.accounts ?? []).some((account) => account.provider === selectedProvider);

  // The scaffold a new project starts from (spec 015). `GET /templates` is the only place the web
  // learns which ids exist — including which one is default — so nothing here names one.
  const templates = useTemplates();
  const [pickedTemplateId, setTemplateId] = useState<ProjectTemplate | undefined>(undefined);
  const templateId = pickedTemplateId ?? templates.data?.default;

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const creation = useMutation({
    mutationFn: ({ name }: { name: string; prompt: string; credential?: 'organisation' }) =>
      // Spec 047: the prompt's first line is a placeholder; the server names the project properly
      // once it has read the prompt, unless somebody renames it first.
      createProject(orgId ?? '', workspaceId ?? '', { autoName: true, name, template: templateId }),
    onSuccess: ({ project }, { credential, prompt }) => {
      void queryClient.invalidateQueries({ queryKey: ['projects', orgId] });
      // The prompt and the model ride along in navigation state: the project page is what acts on
      // them, and a reload of that page starting from nothing is the right outcome for a one-shot
      // input.
      const { choice } = modelState;
      void navigate(projectPath(project.id), {
        state: {
          prompt,
          ...(choice === undefined ? {} : { choice }),
          ...(credential === undefined ? {} : { credential }),
        },
      });
    },
  });

  // The API's own word that nothing can pay: the connect path, not an error.
  const refusedForPayment = ApiProblem.is(creation.error, 'subscription-not-connected');

  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const [isSessionsOpen, setIsSessionsOpen] = useState(false);
  const [isTwoFactorOpen, setIsTwoFactorOpen] = useState(false);

  const openCommandPalette = useCallback(() => {
    setIsPaletteOpen(true);
  }, []);

  // The project's name is the prompt's first line — what somebody typed is the best description
  // there is, and they can rename it later. Whitespace-only is not a project.
  const startProject = useCallback(
    (prompt: string, options?: { credential?: 'organisation' }): void => {
      // Nothing can pay for the run the project would start with: the composer is showing the
      // connect path, and a project created now would only open on a refusal.
      if (prompt.trim().length === 0 || modelState.needsConnection) {
        return;
      }

      const firstLine = prompt.trim().split('\n')[0]?.trim().slice(0, 120) ?? '';

      creation.mutate({
        name: firstLine.length === 0 ? 'Untitled project' : firstLine,
        prompt,
        ...(options?.credential === undefined ? {} : { credential: options.credential }),
      });
    },
    [creation, modelState.needsConnection],
  );

  // A project starts from what somebody asks for, so "New project" takes them to the composer
  // rather than creating one whose first prompt would be the placeholder name.
  const createFromPrompt = useCallback(() => {
    // Next frame: from the palette, its focus trap is still up until the close has rendered.
    requestAnimationFrame(() => {
      const composer = document.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]');

      composer?.scrollIntoView({ block: 'center' });
      composer?.focus();
    });
  }, []);

  useCommandShortcut(openCommandPalette);

  // One clock for every card on the screen, so two projects created a second apart never disagree
  // about which minute it is. It ticks, so "Created 1 minute ago" does not go stale in place.
  const now = useNow();
  const cards = useMemo(
    () => (projects.data?.projects ?? []).map((project) => toProjectCard(project, now)),
    [now, projects.data],
  );

  const workspaces = useMemo(
    () =>
      orgs.map((org) =>
        toWorkspaceSummary(org, org.id === orgId ? members.data?.members.length : undefined),
      ),
    [members.data, orgId, orgs],
  );

  // A just-registered account. ADR 007 makes signup create a user and nothing else, and `GET /orgs`
  // answers with an empty array rather than a 404 precisely so this screen can exist.
  if (isEmpty) {
    return <CreateOrgScreen />;
  }

  if (isGuest) {
    return (
      <GuestHome
        cards={cards}
        error={projects.error}
        isLoading={projects.isLoading}
        orgName={activeOrg?.name ?? ''}
      />
    );
  }

  return (
    <>
      <WorkspaceShell
        account={{ email: user?.email ?? '', name: displayName(user?.email) }}
        activeItem="Home"
        activeWorkspaceId={orgId ?? ''}
        workspaces={workspaces}
        onOpenCommandPalette={openCommandPalette}
        onOpenSessions={() => {
          setIsSessionsOpen(true);
        }}
        onOpenTwoFactor={() => {
          setIsTwoFactorOpen(true);
        }}
        onSelectWorkspace={selectOrg}
      >
        <WorkspaceHero
          error={
            creation.error === null || refusedForPayment ? undefined : messageFor(creation.error)
          }
          isFirstRun={!projects.isLoading && cards.length === 0}
          modelState={modelState}
          name={displayName(user?.email)}
          needsConnection={modelState.needsConnection || refusedForPayment}
          personalAccountsOff={personalAccountsOff}
          suggestions={promptSuggestions}
          templateId={templateId}
          templates={templates.data?.templates ?? []}
          onSelectTemplate={setTemplateId}
          onSubmitPrompt={startProject}
        />

        <ProjectShelf
          error={projects.error}
          isLoading={orgsLoading || projects.isLoading}
          projects={cards}
          onNewProject={createFromPrompt}
          onRetry={() => {
            void projects.refetch();
          }}
        />
      </WorkspaceShell>

      <SessionsDialog open={isSessionsOpen} onOpenChange={setIsSessionsOpen} />
      <TwoFactorDialog open={isTwoFactorOpen} onOpenChange={setIsTwoFactorOpen} />

      <CommandPalette
        open={isPaletteOpen}
        projects={cards}
        onNewProject={createFromPrompt}
        onOpenChange={setIsPaletteOpen}
      />
    </>
  );
}

/**
 * Spec 031 (FR-035): the home of an organisation the caller reaches only through project grants —
 * the projects shared with them, and nothing of the organisation: no workspace switcher, no member
 * count, no settings, no composer (a guest cannot create projects there).
 */
function GuestHome({
  cards,
  error,
  isLoading,
  orgName,
}: {
  cards: readonly ProjectCardModel[];
  error: unknown;
  isLoading: boolean;
  orgName: string;
}): React.JSX.Element {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-10">
      <div>
        <h1 className="text-heading-lg font-semibold">Shared with you</h1>
        <p className="text-body-sm text-subdued mt-1">Projects {orgName} has shared with you.</p>
      </div>
      <section aria-label="Projects">
        {error !== null ? (
          <p className="text-body-sm text-danger" role="alert">
            {messageFor(error, 'The shared projects could not be loaded.')}
          </p>
        ) : isLoading ? (
          <p className="text-body-sm text-subdued" role="status">
            Loading shared projects…
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((card) => (
              <li key={card.id}>
                <ProjectCard project={card} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

/**
 * A name to greet somebody by, from the only identifying field the API returns.
 *
 * `signedInResponseSchema` carries an id, an address and a verification flag — there is no display
 * name in the system, so the local part of the address is the best available answer. Better than
 * inventing a `name` field the server would have to start storing to make true.
 */
function displayName(email: string | undefined): string {
  if (email === undefined) {
    return 'there';
  }

  const local = email.split('@')[0] ?? '';
  const first = local.split(/[._-]/)[0] ?? local;

  return first.length === 0 ? 'there' : `${first[0]?.toUpperCase() ?? ''}${first.slice(1)}`;
}
