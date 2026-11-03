import {
  type CatalogueModel,
  type CreateRunRequest,
  type ModelCatalogueResponse,
  type SubscriptionList,
  localAgentModelSchema,
} from '@repo/contracts';
import { z } from 'zod';

/**
 * What the next message runs on, and so who pays for it (spec 043): the person's own Claude
 * subscription (041's agent home), or a catalogue entry — an organisation key or a 032 linked
 * account. There is no third payer.
 */
export const modelChoiceSchema = z.discriminatedUnion('source', [
  z.strictObject({
    // Absent: the subscription's CLI picks (its list has not been reported yet).
    model: localAgentModelSchema.optional(),
    source: z.literal('subscription'),
  }),
  z.strictObject({ model: z.string().min(1), source: z.literal('catalogue') }),
]);

export type ModelChoice = z.output<typeof modelChoiceSchema>;

/** The create-run body for a prompt on a choice. No choice yet: the API applies its default. */
export function runBody(prompt: string, choice: ModelChoice | undefined): CreateRunRequest {
  if (choice === undefined) return { prompt };
  if (choice.source === 'catalogue') return { model: choice.model, prompt };

  return {
    prompt,
    subscription: { provider: 'claude' },
    ...(choice.model === undefined ? {} : { model: choice.model }),
  };
}

export function sameChoice(a: ModelChoice | undefined, b: ModelChoice | undefined): boolean {
  return a?.source === b?.source && a?.model === b?.model;
}

/** The two reads the picker is built from; `undefined` while a read has not answered. */
export interface ModelSources {
  readonly catalogue: ModelCatalogueResponse | undefined;
  readonly subscriptions: SubscriptionList | undefined;
}

function isOffered(choice: ModelChoice, { catalogue, subscriptions }: ModelSources): boolean {
  if (choice.source === 'catalogue') {
    // Not answered yet: keep the remembered choice rather than flicker to a default.
    if (catalogue === undefined) return true;

    return catalogue.models.some((model) => model.id === choice.model && model.available);
  }

  if (subscriptions === undefined) return true;
  const { models, state } = subscriptions.claude;
  if (state !== 'connected') return false;

  return choice.model === undefined || models === null || models.some((m) => m.id === choice.model);
}

/** What a person who has chosen nothing gets: their own plan first, then the catalogue's default. */
export function defaultChoice({ catalogue, subscriptions }: ModelSources): ModelChoice | undefined {
  if (subscriptions?.claude.state === 'connected') {
    const first = subscriptions.claude.models?.[0]?.id;

    return { source: 'subscription', ...(first === undefined ? {} : { model: first }) };
  }

  const available = catalogue?.models.filter((model) => model.available) ?? [];
  const fallback =
    available.find((model) => model.id === catalogue?.default) ?? available[0] ?? undefined;

  return fallback === undefined ? undefined : { model: fallback.id, source: 'catalogue' };
}

/** The remembered choice while it is still offered, else the default. */
export function resolveChoice(
  stored: ModelChoice | undefined,
  sources: ModelSources,
): ModelChoice | undefined {
  return stored !== undefined && isOffered(stored, sources) ? stored : defaultChoice(sources);
}

/**
 * Nothing can pay: both reads answered, no connected subscription and no catalogue entry. The
 * composer then offers to connect instead of sending (an unknown read is never "nothing").
 */
export function noWayToPay({ catalogue, subscriptions }: ModelSources): boolean {
  return (
    subscriptions !== undefined &&
    subscriptions.claude.state !== 'connected' &&
    catalogue !== undefined &&
    !catalogue.models.some((model) => model.available)
  );
}

/** The catalogue entry a choice names, for the 032 limit and the chip. */
export function catalogueEntry(
  choice: ModelChoice | undefined,
  catalogue: ModelCatalogueResponse | undefined,
): CatalogueModel | undefined {
  return choice?.source === 'catalogue'
    ? catalogue?.models.find((model) => model.id === choice.model)
    : undefined;
}

/** "Sonnet 5", "Opus" — what the chip reads. */
export function choiceLabel(choice: ModelChoice | undefined, sources: ModelSources): string {
  if (choice === undefined) return 'Model';
  if (choice.source === 'catalogue') {
    return catalogueEntry(choice, sources.catalogue)?.shortName ?? choice.model;
  }
  const model = sources.subscriptions?.claude.models?.find((m) => m.id === choice.model);

  return model?.label ?? choice.model ?? 'Claude subscription';
}

function storageKey(projectId: string): string {
  return `baios.model.${projectId}`;
}

/** Storage can be absent, full or forbidden (private windows); each reads as "nothing chosen". */
export function readChoice(projectId: string | undefined): ModelChoice | undefined {
  if (projectId === undefined) return undefined;
  try {
    const raw = window.localStorage.getItem(storageKey(projectId));
    if (raw === null) return undefined;
    const parsed = modelChoiceSchema.safeParse(JSON.parse(raw));

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function writeChoice(projectId: string | undefined, choice: ModelChoice): void {
  if (projectId === undefined) return;
  try {
    window.localStorage.setItem(storageKey(projectId), JSON.stringify(choice));
  } catch {
    // Remembering the choice is a convenience; the run itself does not depend on it.
  }
}

/**
 * How well `query` names `text`: exact 0, prefix 1, word boundary 2, substring 3, else `null`.
 * Lower is better, as a sort key.
 */
function matchScore(text: string, query: string): number | null {
  const value = text.toLowerCase();
  if (value === query) return 0;
  if (value.startsWith(query)) return 1;
  // A word starts after anything that is not a letter or a digit ("claude-sonnet", "Opus 5").
  for (let at = value.indexOf(query); at !== -1; at = value.indexOf(query, at + 1)) {
    if (!/[a-z0-9]/.test(value[at - 1] ?? '')) return 2;
  }

  return value.includes(query) ? 3 : null;
}

/**
 * Filter and rank by the best match over each item's fields: exact > prefix > word boundary >
 * substring, ties in the order given. An empty query keeps everything as it was.
 */
export function rankByQuery<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => readonly string[],
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...items];

  return items
    .map((item, order) => {
      const scores = fields(item)
        .map((field) => matchScore(field, needle))
        .filter((score): score is number => score !== null);

      return { item, order, score: scores.length === 0 ? null : Math.min(...scores) };
    })
    .filter((entry): entry is { item: T; order: number; score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .map((entry) => entry.item);
}
