import {
  DownloadIcon,
  LayoutGridIcon,
  type LucideIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  UserIcon,
  UsersIcon,
} from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { projectPath, routes } from '@/lib/routes';
import { cn } from '@/lib/utils';
import type { Project } from '../types';

interface PaletteItem {
  icon: LucideIcon;
  id: string;
  /** Trailing detail, e.g. when a project was last edited. */
  meta?: string;
  onSelect: () => void;
  title: string;
}

interface PaletteGroup {
  items: readonly PaletteItem[];
  title: string;
}

interface CommandPaletteProps {
  onNewProject: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projects: readonly Project[];
}

function matches(item: { title: string }, query: string): boolean {
  return item.title.toLowerCase().includes(query.trim().toLowerCase());
}

/** Search across projects and workspace actions, opened with ⌘K. */
export function CommandPalette({
  onNewProject,
  onOpenChange,
  open,
  projects,
}: CommandPaletteProps): React.JSX.Element {
  const navigate = useNavigate();
  const listId = useId();
  // A chosen item moves focus somewhere on purpose; the dialog must not pull it back on close.
  const [choseItem, setChoseItem] = useState(false);
  const choose = (item: PaletteItem): void => {
    setChoseItem(true);
    item.onSelect();
  };
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const groups = useMemo<readonly PaletteGroup[]>(() => {
    const go = (to: string) => (): void => {
      onOpenChange(false);
      void navigate(to);
    };

    const candidates: readonly PaletteGroup[] = [
      {
        items: projects.map((project) => ({
          icon: LayoutGridIcon,
          id: project.id,
          meta: project.activity,
          onSelect: go(projectPath(project.id)),
          title: project.name,
        })),
        title: 'Projects',
      },
      {
        items: [
          {
            icon: PlusIcon,
            id: 'new-project',
            onSelect: () => {
              onOpenChange(false);
              onNewProject();
            },
            title: 'Create new project',
          },
          {
            icon: DownloadIcon,
            id: 'import',
            onSelect: go(routes.projectNewImport),
            title: 'Import a GitHub repository',
          },
          {
            icon: UsersIcon,
            id: 'invite',
            onSelect: go(routes.membersSettings),
            title: 'Invite a teammate',
          },
          {
            icon: SettingsIcon,
            id: 'settings',
            onSelect: go(routes.settings),
            title: 'Organisation settings',
          },
          {
            icon: UserIcon,
            id: 'account',
            onSelect: go(routes.accountSettings),
            title: 'Account settings',
          },
        ],
        title: 'Actions',
      },
    ];

    return candidates
      .map((group) => ({ ...group, items: group.items.filter((item) => matches(item, query)) }))
      .filter((group) => group.items.length > 0);
  }, [navigate, onNewProject, onOpenChange, projects, query]);

  const flatItems = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  // Clamp on read rather than storing a corrected index: the result set shrinks
  // under the highlight whenever the query narrows.
  const highlighted = activeIndex < flatItems.length ? activeIndex : 0;
  const activeItem = flatItems[highlighted];

  useEffect(() => {
    if (activeItem) {
      document.getElementById(`${listId}-${activeItem.id}`)?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeItem, listId]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (flatItems.length === 0) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((highlighted + 1) % flatItems.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((highlighted - 1 + flatItems.length) % flatItems.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (activeItem !== undefined) choose(activeItem);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setQuery('');
          setActiveIndex(0);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          if (choseItem) {
            setChoseItem(false);
            event.preventDefault();
          }
        }}
        className="shadow-palette top-[8vh] max-h-[84vh] translate-y-0 rounded-[14px]"
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>

        <div className="flex items-center gap-[11px] py-[15px] pr-[13px] pl-4">
          <SearchIcon className="text-subdued size-[17px] shrink-0" aria-hidden="true" />
          <input
            autoFocus
            type="text"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={activeItem ? `${listId}-${activeItem.id}` : undefined}
            aria-label="Search projects, templates and actions"
            placeholder="Search projects, templates and actions"
            value={query}
            className="text-body-lg text-foreground placeholder:text-faint min-w-0 flex-1 bg-transparent outline-none"
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
          <Kbd className="max-sm:hidden">esc</Kbd>
        </div>

        <div
          id={listId}
          role="listbox"
          aria-label="Results"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {groups.length === 0 ? (
            <p className="text-body-sm text-faint border-line-subtle border-t px-4 py-6 text-center">
              No matches for “{query.trim()}”
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.title} className="border-line-subtle border-t py-2">
                <p className="text-overline text-faint px-4 pb-[5px] font-medium uppercase">
                  {group.title}
                </p>
                {group.items.map((item) => {
                  const isActive = item.id === activeItem?.id;

                  return (
                    <div
                      key={item.id}
                      id={`${listId}-${item.id}`}
                      role="option"
                      aria-selected={isActive}
                      className={cn(
                        'flex cursor-default items-center gap-[11px] px-3.5 py-[9px]',
                        isActive && 'bg-brand-soft',
                      )}
                      onMouseMove={() => {
                        setActiveIndex(flatItems.indexOf(item));
                      }}
                      onClick={() => {
                        choose(item);
                      }}
                    >
                      <item.icon className="text-subdued size-[15px] shrink-0" aria-hidden="true" />
                      <span className="text-label-sm text-foreground min-w-0 flex-1 truncate font-medium">
                        {item.title}
                      </span>
                      {item.meta ? (
                        <span className="text-caption text-faint shrink-0 max-sm:hidden">
                          {item.meta}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="bg-subtle text-caption text-faint flex items-center gap-3.5 px-4 py-2.5">
          <span className="flex items-center gap-1.5">
            <Kbd>↑↓</Kbd>
            navigate
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd>
            open
          </span>
          <span className="ml-auto max-md:hidden">Search projects, templates and actions</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
