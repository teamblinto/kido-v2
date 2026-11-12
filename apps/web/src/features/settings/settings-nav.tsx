import { ArrowLeftIcon } from 'lucide-react';
import { Link, NavLink } from 'react-router-dom';

import { routes } from '@/lib/routes';
import { cn } from '@/lib/utils';

const LINKS = [
  { label: 'Members', to: routes.membersSettings },
  { label: 'Connectors', to: routes.connectorsSettings },
  { label: 'Webhooks', to: routes.webhooksSettings },
  { label: 'AI agents', to: routes.mcpSettings },
  { label: 'Usage', to: routes.usageSettings },
  { label: 'Account', to: routes.accountSettings },
] as const;

/** Links between the settings pages, and the way back to the workspace. */
export function SettingsNav(): React.JSX.Element {
  return (
    <div className="mb-6 flex flex-col gap-4">
      <Link
        to={routes.home}
        className="text-label-sm text-subdued hover:text-foreground inline-flex w-fit items-center gap-1.5"
      >
        <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
        Back to workspace
      </Link>
      <nav aria-label="Settings" className="flex flex-wrap gap-x-4 gap-y-2">
        {LINKS.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            className={({ isActive }) =>
              cn('text-label-sm', isActive ? 'text-foreground font-semibold' : 'text-subdued')
            }
          >
            {link.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
