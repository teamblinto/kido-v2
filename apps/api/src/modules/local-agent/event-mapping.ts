import type {
  CompanionFailureClass,
  CompanionPolicy,
  CompanionRunEvent,
  LocalAgentProvider,
  LocalAgentProviderStatus,
} from '@repo/contracts';

import type { EmittedEvent, RunOutcome } from '../agent/run-executor.port';
import { providerPolicy } from './policy';

const LABELS: Record<LocalAgentProvider, string> = { claude: 'Claude Code', codex: 'Codex' };

/** The run event a streamed companion event becomes (spec 040 § 3 decision 4). */
export function stepIdOf(runId: string, toolId: string): string {
  return `${runId}/${toolId}`;
}

/**
 * The companion's stream as run events, for the types that map one to one. `session`,
 * `approval.request`, `terminal` and `tool.call` carry state the executor keeps, so they answer `undefined`
 * here and are handled there.
 *
 * A CLI tool that failed is `tool.end { ok: true }` with the failure in `output`: the CLI already
 * dealt with it, and a run-level `ok: false` would trip the three-strikes `tool_error` bound
 * (008 FR-008), which is for tools this platform dispatches. A file change has no patch on the
 * wire, so none is invented: it is a line on the tool that made it.
 */
export function mapCompanionEvent(
  runId: string,
  event: CompanionRunEvent,
  openStepId: string | undefined,
): EmittedEvent | undefined {
  switch (event.type) {
    case 'text.delta':
      return { data: { text: event.data.text }, type: 'token' };
    case 'reasoning.delta':
      return { data: { text: event.data.text }, type: 'thought' };
    case 'tool.start':
      return {
        data: {
          input: event.data.input,
          stepId: stepIdOf(runId, event.data.toolId),
          tool: event.data.name,
        },
        type: 'tool.start',
      };
    case 'tool.output':
      return {
        data: { chunk: event.data.chunk, stepId: stepIdOf(runId, event.data.toolId) },
        type: 'tool.delta',
      };
    case 'tool.end':
      return {
        data: {
          ok: true,
          output: event.data.ok ? event.data.summary : { ok: false, summary: event.data.summary },
          stepId: stepIdOf(runId, event.data.toolId),
        },
        type: 'tool.end',
      };
    case 'file.change':
      return {
        data: {
          chunk: `${event.data.kind} ${event.data.path}\n`,
          stepId: openStepId ?? `${runId}/files`,
        },
        type: 'tool.delta',
      };
    case 'usage':
      return {
        data: {
          costMicros: 0,
          inputTokens: event.data.inputTokens,
          outputTokens: event.data.outputTokens,
        },
        type: 'usage',
      };
    case 'session':
    case 'approval.request':
    case 'terminal':
    case 'tool.call':
      return undefined;
  }
}

/**
 * A companion `terminal` as the run's outcome. Completed is `awaiting_input`: the CLI finished
 * its turn and the conversation continues in the same run, resumed from its provider session.
 * Sign-in and usage limits are the person's credential problems, so `credential` — the class the
 * web's subscription-limited and reconnect hints read — with `resetsAt` carried; the rest are
 * `executor` failures naming the companion's class. Every failure also carries the class and
 * provider as `localAgentFailure`, which the web keys on; the reason still names the fix.
 */
export function terminalOutcome(
  data: Extract<CompanionRunEvent, { type: 'terminal' }>['data'],
  provider: LocalAgentProvider,
): RunOutcome {
  if (data.status === 'completed') return { kind: 'awaiting_input' };
  if (data.status === 'interrupted' || data.failure === undefined) return { kind: 'stopped' };

  const { failure } = data;
  const label = LABELS[provider];
  const localAgentFailure = { class: failure.class, provider };

  switch (failure.class) {
    case 'auth':
      return {
        failureClass: 'credential',
        kind: 'failed',
        localAgentFailure,
        reason: `The ${label} CLI on your device is signed out — run \`baios-companion login ${provider}\` and try again`,
      };
    case 'usage_limit':
      return {
        failureClass: 'credential',
        kind: 'failed',
        localAgentFailure,
        reason:
          failure.resetsAt === undefined
            ? `Your ${label} plan's usage limit was reached — try again later`
            : `Your ${label} plan's usage limit was reached until ${failure.resetsAt}`,
        ...(failure.resetsAt === undefined ? {} : { resetsAt: new Date(failure.resetsAt) }),
      };
    default:
      return localFailure(failure.class, provider, failure.message);
  }
}

type Provider = LocalAgentProvider;

/**
 * Every local-run failure the executor itself decides, beside `terminalOutcome`'s — one place for
 * the reasons the web reads (each names the command that fixes it, where one does). The word after
 * `local-agent` says what happened; the class is the companion's vocabulary the web keys on.
 */
export const LOCAL_FAILURES = {
  noTarget: () => localFailure('workspace', undefined, 'the run has no local agent target'),
  noPrompt: (provider: Provider) => localFailure('workspace', provider, 'the run has no prompt'),
  offline: (provider: Provider) =>
    localFailure(
      'transport',
      provider,
      'the device is offline — run `baios-companion start` on it and try again',
      'offline',
    ),
  transport: (provider: Provider) =>
    localFailure(
      'transport',
      provider,
      'the companion stopped responding — check it is running (`baios-companion start`) and try again',
    ),
  notStarted: (provider: Provider) =>
    localFailure(
      'transport',
      provider,
      'the companion did not pick the run up — check it is running (`baios-companion start`) and up to date, and try again',
    ),
  tooLong: (provider: Provider, maxMs: number) =>
    localFailure(
      'provider',
      provider,
      `the turn ran past this deployment's limit of ${String(Math.round(maxMs / 60_000))} minutes and was stopped`,
      'timeout',
    ),
  revoked: (provider: Provider) =>
    localFailure(
      'policy',
      provider,
      'the device was revoked, or is no longer paired to the person who started this run — pair it again with `baios-companion pair`',
      'revoked',
    ),
  accessLost: (provider: Provider) =>
    localFailure(
      'policy',
      provider,
      'the person who started this run can no longer run agents in this project',
      'access',
    ),
  overBudget: (provider: Provider) =>
    localFailure(
      'provider',
      provider,
      'the turn sent more output than this deployment accepts for one turn, and was stopped',
      'budget',
    ),
} as const;

/**
 * Item 5's per-turn re-check of the CLI on its current report: missing, signed out, or on a
 * sign-in the policy no longer allows (Codex on a ChatGPT plan where that is denied).
 */
export function notRunnable(
  status: LocalAgentProviderStatus | undefined,
  provider: Provider,
  policy: CompanionPolicy,
): RunOutcome | undefined {
  const label = LABELS[provider];

  if (status?.installed !== true) {
    return localFailure('provider', provider, `the ${label} CLI is not installed on the device`);
  }

  if (status.auth.status !== 'authenticated') {
    return localFailure(
      'auth',
      provider,
      `the ${label} CLI on the device is signed out — run \`baios-companion login ${provider}\` and try again`,
    );
  }

  const verdict = providerPolicy(status, policy);

  return verdict.allowed
    ? undefined
    : localFailure('policy', provider, verdict.reason ?? 'not allowed here');
}

/** Where the CLI of a local run ran (spec 041): the person's own computer, or their agent home. */
export type LocalAgentOrigin = 'device' | 'subscription';

/**
 * Spec 041: a run in the person's cloud agent home has no companion they could start or sign in,
 * so its reasons never name one — the remedy is Settings, or a minute's patience.
 */
const SUBSCRIPTION_REASONS: Partial<Record<CompanionFailureClass, string>> = {
  auth: 'Your Claude sign-in has expired — reconnect your Claude subscription in Settings.',
  policy: 'Your cloud workspace was disconnected — reconnect your Claude subscription in Settings.',
  transport: 'Your cloud workspace could not be reached — try again in a minute.',
};

/**
 * Stamps a failure with where it ran, so the web picks the remedy from `origin`; a subscription
 * run's reason is rewritten to one that names no companion command (usage limits keep theirs).
 */
export function withOrigin(outcome: RunOutcome, origin: LocalAgentOrigin): RunOutcome {
  if (outcome.kind !== 'failed' || outcome.localAgentFailure === undefined) return outcome;

  const failure = { ...outcome.localAgentFailure, origin };
  const rewritten = origin === 'subscription' ? SUBSCRIPTION_REASONS[failure.class] : undefined;

  return {
    ...outcome,
    localAgentFailure: failure,
    ...(rewritten === undefined ? {} : { reason: rewritten }),
  };
}

/** An `executor` failure in the companion's vocabulary, bounded for the `state` event. */
export function localFailure(
  failureClass: CompanionFailureClass,
  provider: Provider | undefined,
  message: string,
  label: string = failureClass,
): RunOutcome {
  return {
    failureClass: 'executor',
    kind: 'failed',
    ...(provider === undefined ? {} : { localAgentFailure: { class: failureClass, provider } }),
    reason: `local-agent ${label}: ${message}`.slice(0, 1_000),
  };
}
