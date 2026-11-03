import { NavLink } from 'react-router-dom';

import { routes } from '@/lib/routes';
import { cn } from '@/lib/utils';

const LINKS = [
  { label: 'Members', to: routes.membersSettings },
  { label: 'Connectors', to: routes.connectorsSettings },
  { label: 'Webhooks', to: routes.webhooksSettings },
] as const;

/** Links between the organisation's settings pages. */
export function SettingsNav(): React.JSX.Element {
  return (
    <nav aria-label="Settings" className="mb-6 flex gap-4">
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
  );
}
