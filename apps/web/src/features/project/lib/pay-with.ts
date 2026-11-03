import { z } from 'zod';

/** Claude Code's own aliases; `null` leaves the choice to the CLI. */
export const SUBSCRIPTION_MODELS = ['sonnet', 'opus', 'haiku'] as const;

const choiceSchema = z.strictObject({
  model: z.enum(SUBSCRIPTION_MODELS).nullable(),
  payWith: z.enum(['baios', 'subscription']),
});

/** Who pays for the next run (spec 041): BAIOS, as before, or the person's own Claude plan. */
export type PayWithChoice = z.output<typeof choiceSchema>;

export const BAIOS_PAYS: PayWithChoice = { model: null, payWith: 'baios' };

/** What the composer adds to the create-run body for a run on the person's own plan. */
export interface SubscriptionRunRequest {
  readonly model?: string;
  readonly subscription: { readonly provider: 'claude' };
}

function storageKey(projectId: string): string {
  return `baios.pay-with.${projectId}`;
}

/** Storage can be absent, full or forbidden (private windows); each reads as "BAIOS pays". */
export function readPayWith(projectId: string | undefined): PayWithChoice {
  if (projectId === undefined) return BAIOS_PAYS;
  try {
    const raw = window.localStorage.getItem(storageKey(projectId));
    if (raw === null) return BAIOS_PAYS;
    const parsed = choiceSchema.safeParse(JSON.parse(raw));

    return parsed.success ? parsed.data : BAIOS_PAYS;
  } catch {
    return BAIOS_PAYS;
  }
}

export function writePayWith(projectId: string | undefined, choice: PayWithChoice): void {
  if (projectId === undefined) return;
  try {
    window.localStorage.setItem(storageKey(projectId), JSON.stringify(choice));
  } catch {
    // Remembering the choice is a convenience; the run itself does not depend on it.
  }
}

export function toRunRequest(choice: PayWithChoice): SubscriptionRunRequest | undefined {
  if (choice.payWith === 'baios') return undefined;

  return {
    subscription: { provider: 'claude' },
    ...(choice.model === null ? {} : { model: choice.model }),
  };
}
