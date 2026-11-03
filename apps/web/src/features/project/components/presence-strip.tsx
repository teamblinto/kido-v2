import type { PresenceLocation, PresenceResponse } from '@repo/contracts';

/** How a location reads in a marker's tooltip. */
function describeLocation(location: PresenceLocation): string {
  switch (location.view) {
    case 'code':
      return location.path === undefined ? 'Code' : `Code: ${location.path}`;
    case 'history':
      return 'History';
    case 'preview':
      return 'Preview';
    case 'run':
      return 'Watching a run';
  }
}

interface PresenceStripProps {
  readonly presence: PresenceResponse | undefined;
}

/**
 * The other people on this project (spec 031, US3): one marker each, the address's initial, with
 * the full address and where they are in the tooltip. Nothing when presence is unavailable
 * (FR-030) or nobody else is here.
 */
export function PresenceStrip({ presence }: PresenceStripProps): React.JSX.Element | null {
  if (presence?.available !== true || presence.people.length === 0) {
    return null;
  }

  return (
    <ul aria-label="Also here" className="flex items-center -space-x-1.5">
      {presence.people.map((person) => {
        const label = `${person.email} — ${describeLocation(person.location)}`;

        return (
          <li
            key={person.userId}
            aria-label={label}
            title={label}
            className="bg-muted text-foreground border-line-subtle flex size-7 items-center justify-center rounded-full border text-label-sm font-medium"
          >
            <span aria-hidden>{person.email.charAt(0).toUpperCase()}</span>
          </li>
        );
      })}
    </ul>
  );
}
