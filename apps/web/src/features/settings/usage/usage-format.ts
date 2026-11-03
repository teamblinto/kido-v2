import type { SubscriptionUsageWindow, UsagePaidWith, UsageRun } from '@repo/contracts';

export const WINDOW_LABEL: Record<SubscriptionUsageWindow['kind'], string> = {
  session: 'Current session',
  weekly: 'This week',
  'weekly-opus': 'This week · Opus',
  'weekly-sonnet': 'This week · Sonnet',
};

export const PAID_WITH_LABEL: Record<UsagePaidWith, string> = {
  'api-key': 'API key',
  'platform-credits': 'Platform credits (retired)',
  subscription: 'Subscription',
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Resets in 2 h 10 min"; minutes round up, so a reset a few seconds out is never "0 min". */
export function formatResetsIn(resetsAt: string, now: number): string {
  const left = Date.parse(resetsAt) - now;

  if (left <= 0) return 'Resets now';

  const minutes = Math.ceil(left / MINUTE);
  const days = Math.floor(minutes / (DAY / MINUTE));
  const hours = Math.floor((minutes % (DAY / MINUTE)) / 60);
  const mins = minutes % 60;

  if (days > 0) return `Resets in ${String(days)} d ${String(hours)} h`;
  if (hours > 0) return `Resets in ${String(hours)} h ${String(mins)} min`;
  return `Resets in ${String(mins)} min`;
}

/** "Updated 3 min ago". */
export function formatUpdatedAgo(checkedAt: string, now: number): string {
  const ago = Math.max(0, now - Date.parse(checkedAt));

  if (ago < MINUTE) return 'Updated just now';
  if (ago < HOUR) return `Updated ${String(Math.floor(ago / MINUTE))} min ago`;
  if (ago < DAY) return `Updated ${String(Math.floor(ago / HOUR))} h ago`;
  return `Updated ${String(Math.floor(ago / DAY))} d ago`;
}

/** Micro-dollars as dollars: four places under a dollar ($0.0123), cents above; "—" unpriced. */
export function formatCost(micros: number | null): string {
  if (micros === null) return '—';

  const places = micros < 1_000_000 && micros > 0 ? 4 : 2;

  return new Intl.NumberFormat('en-US', {
    currency: 'USD',
    maximumFractionDigits: places,
    minimumFractionDigits: places,
    style: 'currency',
  }).format(micros / 1_000_000);
}

export function formatTokens(count: number): string {
  return new Intl.NumberFormat().format(count);
}

/** `awaiting_input` → "Awaiting input". */
export function formatRunStatus(status: UsageRun['status']): string {
  const words = status.replaceAll('_', ' ');

  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function formatRunDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}
