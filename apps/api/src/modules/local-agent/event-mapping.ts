import type {
  CompanionFailureClass,
  CompanionPolicy,
  CompanionRunEvent,
  LocalAgentProvider,
  LocalAgentProviderStatus,
} from '@repo/contracts';

import type { EmittedEvent, RunOutcome } from '../agent/run-executor.port';
import { providerPolicy } from './policy';

const LABELS: Record<LocalAgentProvider, string> = { claude: 'Claude Code' };

/** The run event a streamed companion event becomes (spec 040 § 3 decision 4). */
export function stepIdOf(runId: string, toolId: string): string {
  return `${runId}/${toolId}`;
}

/**
 * The runner's stream as run events, for the types that map one to one. `session`, `terminal`
 * and `tool.call` carry state the executor keeps, so they answer `undefined` here and are handled
 * there.
 *
 * A CLI tool that failed is `tool.end { ok: true }` with the failure in `output`: the CLI already
 * dealt with it, and a run-level `ok: false` would trip the three-strikes `tool_error` bound
 * (008 FR-008), which is for tools this platform dispatches.
 */
export function mapCompanionEvent(
  runId: string,
  event: CompanionRunEvent,
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
        reason: `The ${label} CLI is signed out — reconnect your Claude subscription and try again`,
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
 * Every subscription-run failure the executor itself decides, beside `terminalOutcome`'s — one
 * place for the reasons the web reads. The word after `local-agent` says what happened; the class
 * is the runner's vocabulary the web keys on.
 */
export const LOCAL_FAILURES = {
  noTarget: () => localFailure('workspace', undefined, 'the run has no local agent target'),
  noPrompt: (provider: Provider) => localFailure('workspace', provider, 'the run has no prompt'),
  /**
   * A run admitted on a person's own paired computer before that feature was retired (spec 040):
   * it has no agent home and no sandbox toolset, so it is failed rather than run anywhere.
   */
  retired: () =>
    localFailure(
      'policy',
      undefined,
      'this run was started on your own computer, which BAIOS no longer runs agents on — start it again on your Claude subscription',
      'retired',
    ),
  offline: (provider: Provider) =>
    localFailure('transport', provider, 'the agent home is offline', 'offline'),
  transport: (provider: Provider) =>
    localFailure('transport', provider, 'the agent home stopped responding'),
  notStarted: (provider: Provider) =>
    localFailure('transport', provider, 'the agent home did not pick the run up'),
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
      'the agent home was disconnected, or no longer belongs to the person who started this run',
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
 * sign-in the policy does not allow.
 */
export function notRunnable(
  status: LocalAgentProviderStatus | undefined,
  provider: Provider,
  policy: CompanionPolicy,
): RunOutcome | undefined {
  const label = LABELS[provider];

  if (status?.installed !== true) {
    return localFailure(
      'provider',
      provider,
      `the ${label} CLI is not installed in the agent home`,
    );
  }

  if (status.auth.status !== 'authenticated') {
    return localFailure('auth', provider, `the ${label} CLI in the agent home is signed out`);
  }

  const verdict = providerPolicy(status, policy);

  return verdict.allowed
    ? undefined
    : localFailure('policy', provider, verdict.reason ?? 'not allowed here');
}

/**
 * Spec 041: a run in the person's cloud agent home has nothing they could start or sign in by
 * hand, so its reasons point to Settings, or a minute's patience.
 */
const SUBSCRIPTION_REASONS: Partial<Record<CompanionFailureClass, string>> = {
  auth: 'Your Claude sign-in has expired — reconnect your Claude subscription in Settings.',
  policy: 'Your cloud workspace was disconnected — reconnect your Claude subscription in Settings.',
  transport: 'Your cloud workspace could not be reached — try again in a minute.',
};

/**
 * Stamps a failure `origin: 'subscription'` — the only origin now; `device` is on events from the
 * retired local-agent feature only — and gives it the Settings remedy (usage limits keep theirs).
 */
export function withOrigin(outcome: RunOutcome): RunOutcome {
  if (outcome.kind !== 'failed' || outcome.localAgentFailure === undefined) return outcome;

  const failure = { ...outcome.localAgentFailure, origin: 'subscription' as const };
  // A starter who lost project access is `policy` too, but no reconnect fixes that: keep its words.
  const rewritten = outcome.reason.startsWith('local-agent access:')
    ? undefined
    : SUBSCRIPTION_REASONS[failure.class];

  return {
    ...outcome,
    localAgentFailure: failure,
    ...(rewritten === undefined ? {} : { reason: rewritten }),
  };
}

/** An `executor` failure in the runner's vocabulary, bounded for the `state` event. */
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
