import {
  ChevronDownIcon,
  CodeIcon,
  DatabaseIcon,
  GitBranchIcon,
  GlobeIcon,
  LayoutGridIcon,
  type LucideIcon,
  MessageSquareIcon,
  PanelLeftIcon,
  RocketIcon,
  Share2Icon,
} from 'lucide-react';
import type { PresenceResponse } from '@repo/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { GitHubIcon } from '@/components/icons/brand-icons';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { deleteProject, listWorkspaces, renameProject } from '@/features/workspace/api';
import type { Account } from '@/features/workspace/types';
import { messageFor } from '@/lib/api/problem';
import { routes } from '@/lib/routes';
import { cn } from '@/lib/utils';
import { useSite } from '../hooks/use-deployments';
import type { RunPhase, StageTab } from '../types';
import { DeployPanel } from './deploy-panel';
import { DomainsPanel } from './domains-panel';
import { IntegrationsPanel } from './integrations-panel';
import { RunStatusChip } from './run-status-chip';
import { PresenceStrip } from './presence-strip';
import { SegmentedControl, type SegmentedItem } from './segmented-control';
import { SharePanel } from './share-panel';

/**
 * The query parameter a link opens a side panel with, and the value that opens Domains. The api's
 * domain notices link to `/projects/{id}?panel=domains` (`projectDomainsUrl`, spec 028 R14).
 */
const PANEL_PARAM = 'panel';
const DOMAINS_PANEL = 'domains';
/** Spec 031: `?panel=share` opens the share sheet, on the Domains pattern. */
const SHARE_PANEL = 'share';

/** Panes reachable below `lg`, where the chat and the stage cannot share a row. */
export type MobilePane = 'chat' | StageTab;

interface ProjectTopbarProps {
  account: Account;
  /** Number badge on the Code tab — how many files the run touched. */
  changedFileCount: number;
  isChatOpen: boolean;
  mobilePane: MobilePane;
  onChangeMobilePane: (pane: MobilePane) => void;
  onChangeStage: (stage: StageTab) => void;
  onToggleChat: () => void;
  orgId: string | undefined;
  /** The caller's own permissions on this project; `project:deploy` gates the deploy actions. */
  permissions: readonly string[];
  /** The run's phase; absent while no run exists, so the bar claims none. */
  phase?: RunPhase | undefined;
  /** Who else has this project open (spec 031, US3). */
  presence?: PresenceResponse;
  /** Where the run said its preview is. Absent until it has said (FR-028). */
  projectId: string | undefined;
  projectName: string;
  stage: StageTab;
}

const stageItems: readonly SegmentedItem<StageTab>[] = [
  { icon: LayoutGridIcon, id: 'preview', label: 'Preview' },
  { icon: CodeIcon, id: 'code', label: 'Code' },
  { icon: GitBranchIcon, id: 'git', label: 'Git' },
];

/**
 * The bar above everything: which project you are in, how its run is going,
 * which pane of the stage is showing, and how to ship it.
 *
 * Below `lg` the stage tabs drop to a second row and gain a Chat segment, since
 * the chat panel and the stage can no longer sit side by side.
 */
export function ProjectTopbar({
  account,
  changedFileCount,
  isChatOpen,
  mobilePane,
  onChangeMobilePane,
  onChangeStage,
  onToggleChat,
  orgId,
  permissions,
  phase,
  presence,
  projectId,
  projectName,
  stage,
}: ProjectTopbarProps): React.JSX.Element {
  const [isDeployOpen, setDeployOpen] = useState(false);
  // Every reader may open the panel for the address and the history; only a member holding
  // `project:deploy` is shown the actions inside it, and the button says which it is.
  const canDeploy = permissions.includes('project:deploy');
  const [isDomainsToggled, setDomainsToggled] = useState(false);
  // Spec 030 US3: the project's Neon and Supabase bindings, for anyone who may read the project.
  const [isIntegrationsOpen, setIntegrationsOpen] = useState(false);
  const showIntegrations =
    permissions.includes('project:read') && orgId !== undefined && projectId !== undefined;
  // Domains are offered only where one could serve something: a deployable project (spec 028).
  // Who may manage them is the list's `canManage`, since org permissions are not on the project.
  const site = useSite({ orgId, projectId });
  const showDomains = permissions.includes('project:read') && site.data?.deployable === true;
  // A mail link arrives with `?panel=domains`: the panel opens once Domains is offered at all.
  const [searchParams, setSearchParams] = useSearchParams();
  const isDomainsLinked = searchParams.get(PANEL_PARAM) === DOMAINS_PANEL;
  const isDomainsOpen = isDomainsToggled || (isDomainsLinked && showDomains);
  const setDomainsOpen = (open: boolean): void => {
    setDomainsToggled(open);
    // Closing spends the link, so the panel stays closed rather than reopening from the URL.
    if (!open && isDomainsLinked) {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);

          next.delete(PANEL_PARAM);

          return next;
        },
        { replace: true },
      );
    }
  };

  // Spec 031 US2 (FR-022): sharing is the owner's — no control at all without the permission.
  const canShare = permissions.includes('project:share.external');
  const [isShareToggled, setShareToggled] = useState(false);
  const isShareLinked = searchParams.get(PANEL_PARAM) === SHARE_PANEL;
  const isShareOpen = canShare && (isShareToggled || isShareLinked);
  const setShareOpen = (open: boolean): void => {
    setShareToggled(open);
    if (!open && isShareLinked) {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);

          next.delete(PANEL_PARAM);

          return next;
        },
        { replace: true },
      );
    }
  };

  // Rename and delete (spec 007) are workspace routes, and `ProjectSummary` carries no workspace id
  // (T30). Every project the web creates goes into the org's first workspace (the composer and the
  // import both pick it), so that is the one these address. Resolved on use rather than on mount,
  // so opening a project asks for nothing it may never need.
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const firstWorkspaceId = async (): Promise<string> => {
    const { workspaces } = await queryClient.fetchQuery({
      queryFn: ({ signal }) => listWorkspaces(orgId ?? '', signal),
      queryKey: ['workspaces', orgId],
    });

    return workspaces[0]?.id ?? '';
  };
  const rename = useMutation({
    mutationFn: async (name: string) =>
      renameProject(orgId ?? '', await firstWorkspaceId(), projectId ?? '', { name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project', orgId, projectId] });
      void queryClient.invalidateQueries({ queryKey: ['projects', orgId] });
    },
  });
  const remove = useMutation({
    mutationFn: async () => deleteProject(orgId ?? '', await firstWorkspaceId(), projectId ?? ''),
    onSuccess: () => {
      // Leave first: refetching the page's own project now would only answer 404.
      void navigate(routes.home, { replace: true });
      queryClient.removeQueries({ queryKey: ['project', orgId, projectId] });
      void queryClient.invalidateQueries({ queryKey: ['projects', orgId] });
    },
  });
  const canManage = orgId !== undefined && projectId !== undefined;
  const manageError = rename.error ?? remove.error;

  const tabs = stageItems.map((item) =>
    item.id === 'code' ? { ...item, badge: changedFileCount } : item,
  );

  const mobileItems: readonly SegmentedItem<MobilePane>[] = [
    { icon: MessageSquareIcon, id: 'chat', label: 'Chat' },
    ...tabs,
  ];

  return (
    <header className="bg-raised border-line-subtle border-b">
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <TopbarIconButton
          icon={PanelLeftIcon}
          isActive={isChatOpen}
          label={isChatOpen ? 'Hide the chat panel' : 'Show the chat panel'}
          onClick={onToggleChat}
          className="max-lg:hidden"
        />

        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              'text-label-sm text-foreground hover:bg-muted flex min-w-0 items-center gap-[7px]',
              'rounded-md px-2 py-1.5 font-medium transition-colors',
            )}
          >
            <span className="truncate">{projectName}</span>
            <ChevronDownIcon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="sr-only">Switch project</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[240px]">
            <DropdownMenuItem>Project settings</DropdownMenuItem>
            <DropdownMenuItem
              disabled={!canManage || rename.isPending}
              onSelect={() => {
                const name = window.prompt('Rename project', projectName)?.trim();
                if (name !== undefined && name !== '' && name !== projectName) rename.mutate(name);
              }}
            >
              Rename project
            </DropdownMenuItem>
            <DropdownMenuItem>Duplicate project</DropdownMenuItem>
            <DropdownMenuItem
              disabled={!canManage || remove.isPending}
              onSelect={() => {
                if (
                  window.confirm(`Delete ${projectName}? It is archived and leaves every list.`)
                ) {
                  remove.mutate();
                }
              }}
            >
              Delete project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {phase === undefined ? null : <RunStatusChip phase={phase} className="max-sm:hidden" />}

        <span className="flex-1" />

        <SegmentedControl
          ariaLabel="Stage"
          controls="project-stage"
          items={tabs}
          onChange={onChangeStage}
          value={stage}
          className="max-lg:hidden"
        />

        <span className="hidden flex-1 lg:block" />

        <PresenceStrip presence={presence} />

        <span className="bg-line h-[22px] w-px max-lg:hidden" aria-hidden="true" />

        <a
          href="https://github.com"
          target="_blank"
          rel="noreferrer"
          className={cn(
            'text-subdued hover:bg-muted hover:text-foreground flex size-[30px] items-center',
            'justify-center rounded-md transition-colors max-lg:hidden',
          )}
        >
          <GitHubIcon className="size-4" />
          <span className="sr-only">Open the repository on GitHub</span>
        </a>

        <Avatar className="size-[26px] max-sm:hidden">
          <AvatarFallback>{account.name.slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>

        {canShare ? (
          <Button
            size="sm"
            variant="outline"
            className="gap-[7px] rounded-md px-[11px]"
            aria-haspopup="dialog"
            aria-expanded={isShareOpen}
            onClick={() => {
              setShareOpen(true);
            }}
          >
            <Share2Icon className="size-3.5" aria-hidden="true" />
            Share
          </Button>
        ) : null}

        {showDomains ? (
          <Button
            size="sm"
            variant="outline"
            className="gap-[7px] rounded-md px-[11px]"
            aria-haspopup="dialog"
            aria-expanded={isDomainsOpen}
            onClick={() => {
              setDomainsOpen(true);
            }}
          >
            <GlobeIcon className="size-3.5" aria-hidden="true" />
            Domains
          </Button>
        ) : null}

        {showIntegrations ? (
          <Button
            size="sm"
            variant="outline"
            className="gap-[7px] rounded-md px-[11px]"
            aria-haspopup="dialog"
            aria-expanded={isIntegrationsOpen}
            onClick={() => {
              setIntegrationsOpen(true);
            }}
          >
            <DatabaseIcon className="size-3.5" aria-hidden="true" />
            Integrations
          </Button>
        ) : null}

        <Button
          size="sm"
          variant={canDeploy ? 'default' : 'outline'}
          className="gap-[7px] rounded-md px-[11px]"
          aria-haspopup="dialog"
          aria-expanded={isDeployOpen}
          onClick={() => {
            setDeployOpen(true);
          }}
        >
          <RocketIcon className="size-3.5" aria-hidden="true" />
          {canDeploy ? 'Deploy' : 'Site'}
        </Button>

        <Sheet open={isDeployOpen} onOpenChange={setDeployOpen}>
          <SheetContent
            side="right"
            className="w-[420px] overflow-y-auto"
            aria-describedby={undefined}
          >
            <SheetTitle className="sr-only">Deploys</SheetTitle>
            {/* Mounted only while open, so the project screen polls nothing it is not showing. */}
            {isDeployOpen ? (
              <DeployPanel orgId={orgId} permissions={permissions} projectId={projectId} />
            ) : null}
          </SheetContent>
        </Sheet>

        <Sheet open={isIntegrationsOpen} onOpenChange={setIntegrationsOpen}>
          <SheetContent
            side="right"
            className="w-[480px] overflow-y-auto"
            aria-describedby={undefined}
          >
            <SheetTitle className="sr-only">Integrations</SheetTitle>
            {/* Mounted only while open, as the other panels are, so nothing polls unseen. */}
            {isIntegrationsOpen && orgId !== undefined && projectId !== undefined ? (
              <IntegrationsPanel orgId={orgId} permissions={permissions} projectId={projectId} />
            ) : null}
          </SheetContent>
        </Sheet>

        <Sheet open={isShareOpen} onOpenChange={setShareOpen}>
          <SheetContent
            side="right"
            className="w-[480px] overflow-y-auto"
            aria-describedby={undefined}
          >
            <SheetTitle className="sr-only">Share</SheetTitle>
            {/* Mounted only while open, as the other panels are. */}
            {isShareOpen ? <SharePanel orgId={orgId} projectId={projectId} /> : null}
          </SheetContent>
        </Sheet>

        <Sheet open={isDomainsOpen} onOpenChange={setDomainsOpen}>
          <SheetContent
            side="right"
            className="w-[480px] overflow-y-auto"
            aria-describedby={undefined}
          >
            <SheetTitle className="sr-only">Domains</SheetTitle>
            {/* Mounted only while open, as the deploy panel is, so nothing polls unseen. */}
            {isDomainsOpen ? <DomainsPanel orgId={orgId} projectId={projectId} /> : null}
          </SheetContent>
        </Sheet>
      </div>

      {manageError === null ? null : (
        <p className="text-body-sm text-danger px-3.5 pb-2.5" role="alert">
          {messageFor(manageError, 'That change did not go through. Please try again.')}
        </p>
      )}

      <div className="px-3.5 pb-2.5 lg:hidden">
        <SegmentedControl
          ariaLabel="Pane"
          controls="project-stage"
          items={mobileItems}
          onChange={onChangeMobilePane}
          responsive
          value={mobilePane}
        />
      </div>
    </header>
  );
}

function TopbarIconButton({
  className,
  icon: Icon,
  isActive = false,
  label,
  onClick,
}: {
  className?: string;
  icon: LucideIcon;
  isActive?: boolean;
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={isActive}
      onClick={onClick}
      className={cn(
        'flex size-[30px] shrink-0 items-center justify-center rounded-md transition-colors',
        isActive ? 'bg-muted text-foreground' : 'text-subdued hover:bg-muted hover:text-foreground',
        className,
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </button>
  );
}
