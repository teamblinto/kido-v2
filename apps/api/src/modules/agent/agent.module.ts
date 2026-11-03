import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import type { Environment } from '../../config/environment';
import { TenantContext } from '../../database/tenant-context';

import { CheckpointService } from '../checkpoints/checkpoint.service';
import { CheckpointsModule } from '../checkpoints/checkpoints.module';
import { IdentityModule } from '../identity/identity.module';
import { OutboxModule } from '../outbox/outbox.module';
import { RbacModule } from '../rbac/rbac.module';
import { SANDBOX_LIFECYCLE, type SandboxLifecycle } from '../sandbox/sandbox-lifecycle';
import { SANDBOX_TIMINGS, type SandboxTimings } from '../sandbox/sandbox.constants';
import { SandboxModule } from '../sandbox/sandbox.module';
import { SANDBOX_PORT, type SandboxPort } from '../sandbox/sandbox.port';
import { TenancyModule } from '../tenancy/tenancy.module';
import {
  AGENT_ALLOWED_TOOLS,
  AGENT_TIMINGS,
  ANTHROPIC_TRANSPORT,
  type AnthropicTransport,
  DEFAULT_AGENT_TIMINGS,
  LLM_PROVIDER,
  RUN_EXECUTOR,
} from './agent.constants';
import { AgentExecutor } from './agent-executor';
import { AgentRunConsumer } from './agent-run.consumer';
import { AnthropicProvider } from './anthropic.adapter';
import { LLM_PROVIDERS } from '@repo/contracts';
import { ByosMailConsumer } from './byos/byos-mail.consumer';
import { ByosProviders } from './byos/byos-providers';
import { ByosTokenService } from './byos/byos-token.service';
import { anthropicSubscription } from './byos/anthropic.subscription';
import { openAiSubscription } from './byos/openai.subscription';
import { LinkStateStore } from './byos/link-state.store';
import { LinkedAccountRepository } from './byos/linked-account.repository';
import {
  BEARER_VERIFIERS,
  type BearerVerifiers,
  LinkedAccountService,
} from './byos/linked-account.service';
import { SUBSCRIPTION_CLIENTS, type SubscriptionClients } from './byos/subscription-client.port';
import { CatalogueService } from './byok/catalogue.service';
import { CredentialResolver } from './byok/credential-resolver';
import { ProviderKeyHealthConsumer } from './byok/provider-key-health.consumer';
import { LinkedAccountHealthConsumer } from './byos/linked-account-health.consumer';
import { ProviderKeyRepository } from './byok/provider-key.repository';
import { KEY_VERIFIERS, type KeyVerifiers, ProviderKeyService } from './byok/provider-key.service';
import { LinkedAccountController } from './controllers/linked-account.controller';
import { ModelsController } from './controllers/models.controller';
import { ProviderKeyController } from './controllers/provider-key.controller';
import { ContextAssembler } from './context/context-assembler';
import { OpenAiProvider } from './openai.adapter';
import { RunController } from './controllers/run.controller';
import { EventBatcherFactory } from './event-batcher';
import { ProviderRouter } from './provider-router';
import { RunService } from './run.service';
import { RunAccessConsumer } from './run-access.consumer';
import { RunControl } from './run-control';
import { RunExecutorRegistry } from './run-executor-registry';
import { RunLineService } from './run-line.service';
import { RunQueueConsumer } from './run-queue.consumer';
import { RunReaper } from './run-reaper';
import { RunStore } from './run-store';
import { RunStreamPublisher } from './run-stream-publisher';
import { RunStreamReader } from './run-stream-reader';
import { ALL_TOOLS, SandboxTools } from './sandbox-tools';
import { ScriptedExecutor } from './scripted-executor';
import type { ToolName } from './tools';
import { DEFAULT_STREAM_TIMINGS, STREAM_TIMINGS } from './stream.constants';

// ponytail: rewrites `model` in the request body so a local proxy that namespaces ids (`cc/…`)
// serves the catalogue's bare ids, and strips the suffix such a proxy appends to tool names on
// the way back (`fs_edit` → `fs_edit_ide`); absent when neither is configured.
function proxyFetch(
  prefix: string | undefined,
  toolSuffix: string | undefined,
): typeof globalThis.fetch | undefined {
  if (prefix === undefined && toolSuffix === undefined) return undefined;
  return async (input, init) => {
    let request = init;
    if (prefix !== undefined && typeof init?.body === 'string') {
      const body = JSON.parse(init.body) as { model?: string };
      if (typeof body.model === 'string') body.model = `${prefix}${body.model}`;
      request = { ...init, body: JSON.stringify(body) };
    }
    const response = await globalThis.fetch(input, request);
    if (toolSuffix === undefined || response.body === null) return response;
    // The suffix is a plain token (`_ide`); no regex escaping needed for a local knob.
    const needle = new RegExp(`("name":"[^"]*)${toolSuffix}"`, 'g');
    let pending = '';
    const stripped = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(
      new TransformStream<string, string>({
        transform(chunk, controller) {
          const lines = (pending + chunk).split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) controller.enqueue(`${line.replaceAll(needle, '$1"')}\n`);
        },
        flush(controller) {
          controller.enqueue(pending.replaceAll(needle, '$1"'));
        },
      }),
    );
    return new Response(stripped.pipeThrough(new TextEncoderStream()), response);
  };
}

/**
 * The agent run as a durable job (spec 008). `TenancyModule` for `ProjectService` — the liveness
 * check on create — and `OutboxModule` for `OutboxWriter`; `AuditService`, `TenantContext` and
 * `TenantTransactionRunner` arrive from the global modules. The consumer is an ordinary provider
 * `QueueRegistry` discovers; the reaper starts its own interval and the control channel its own
 * subscriber at bootstrap, so `outbox` and the root import nothing new.
 *
 * `CheckpointsModule` for the turn-end commit (spec 016, research R4).
 * `RUN_EXECUTOR` is the real `AgentExecutor` (spec 011) over `SandboxModule`'s port and the
 * `ProviderRouter` under `LLM_PROVIDER` (020 R2), dispatching on the credential's provider to
 * the Anthropic or OpenAI adapter; `ANTHROPIC_TRANSPORT` is the empty default so the adapter
 * reaches the SDK's own base URL, and the adapter spec swaps it for a loopback fake (the OpenAI
 * adapter's transport is `@Optional`, so it takes its own default with no provider here).
 * `KEY_VERIFIERS` (020 US1) is the two adapters keyed by provider name, for `ProviderKeyService`;
 * the e2e suite overrides the token with doubles.
 * `ScriptedExecutor` stays a plain provider for the e2e suites to `overrideProvider` onto.
 * `AGENT_TIMINGS` is a provider so the fencing suite can override every interval at once;
 * `STREAM_TIMINGS` likewise for the stream suite (009).
 *
 * Spec 032: `IdentityModule` for `AccountService.noticeAddress`, the one question the BYOS mail
 * consumer asks identity (R1); `SUBSCRIPTION_CLIENTS` is the generic RFC client for each provider
 * whose `BYOS_<P>_*` set is configured: the provider's own client (T057, T059).
 * `LinkedAccountController` is the person's own `/me/linked-accounts` (T019/T025); its service
 * checks a new token through `BEARER_VERIFIERS`, the adapters' `verifyBearer`, which the e2e suite
 * may override like `KEY_VERIFIERS`.
 */
@Module({
  controllers: [LinkedAccountController, ModelsController, ProviderKeyController, RunController],
  // Spec 040: the local agent module registers its executor here and reads a run through the
  // service, so the edge is `local-agent → agent` only.
  // Spec 041: `SandboxTools` is how a local run on the sandbox tool bridge reaches the sandbox.
  exports: [RunExecutorRegistry, RunService, SandboxTools],
  imports: [
    CheckpointsModule,
    IdentityModule,
    OutboxModule,
    RbacModule,
    SandboxModule,
    TenancyModule,
  ],
  providers: [
    { provide: AGENT_TIMINGS, useValue: DEFAULT_AGENT_TIMINGS },
    {
      provide: ANTHROPIC_TRANSPORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>): AnthropicTransport => ({
        baseURL: config.get('ANTHROPIC_BASE_URL', { infer: true }),
        fetch: proxyFetch(
          config.get('ANTHROPIC_MODEL_PREFIX', { infer: true }),
          config.get('ANTHROPIC_TOOL_SUFFIX', { infer: true }),
        ),
      }),
    },
    { provide: LLM_PROVIDER, useExisting: ProviderRouter },
    {
      provide: KEY_VERIFIERS,
      inject: [AnthropicProvider, OpenAiProvider],
      useFactory: (anthropic: AnthropicProvider, openai: OpenAiProvider): KeyVerifiers => ({
        anthropic,
        openai,
      }),
    },
    {
      provide: BEARER_VERIFIERS,
      inject: [AnthropicProvider, OpenAiProvider],
      useFactory: (anthropic: AnthropicProvider, openai: OpenAiProvider): BearerVerifiers => ({
        anthropic,
        openai,
      }),
    },
    { provide: RUN_EXECUTOR, useClass: AgentExecutor },
    {
      provide: SUBSCRIPTION_CLIENTS,
      inject: [ByosProviders, ConfigService],
      useFactory: (
        byos: ByosProviders,
        config: ConfigService<Environment, true>,
      ): SubscriptionClients =>
        Object.fromEntries(
          LLM_PROVIDERS.flatMap((provider) => {
            const configuration = byos.configuration(provider);
            if (configuration === undefined) return [];
            const options = { timeoutMs: config.get('BYOS_REFRESH_TIMEOUT_MS', { infer: true }) };
            return [
              [
                provider,
                provider === 'openai'
                  ? openAiSubscription(configuration, options)
                  : anthropicSubscription(configuration, options),
              ],
            ];
          }),
        ),
    },
    { provide: STREAM_TIMINGS, useValue: DEFAULT_STREAM_TIMINGS },
    {
      provide: SandboxTools,
      inject: [
        SANDBOX_PORT,
        SANDBOX_LIFECYCLE,
        TenantContext,
        CheckpointService,
        SANDBOX_TIMINGS,
        CLOCK,
        { optional: true, token: AGENT_ALLOWED_TOOLS },
      ],
      useFactory: (
        port: SandboxPort,
        lifecycle: SandboxLifecycle,
        tenant: TenantContext,
        checkpoints: CheckpointService,
        sandboxTimings: SandboxTimings,
        clock: ClockPort,
        allowed: ReadonlySet<ToolName> | undefined,
      ) =>
        new SandboxTools({
          allowed: allowed ?? ALL_TOOLS,
          checkpoints,
          clock,
          lifecycle,
          port,
          sandboxTimings,
          tenant,
        }),
    },
    AgentExecutor,
    AgentRunConsumer,
    AnthropicProvider,
    ByosMailConsumer,
    ByosProviders,
    ByosTokenService,
    CatalogueService,
    ContextAssembler,
    CredentialResolver,
    EventBatcherFactory,
    LinkStateStore,
    LinkedAccountRepository,
    LinkedAccountService,
    OpenAiProvider,
    ProviderKeyHealthConsumer,
    LinkedAccountHealthConsumer,
    ProviderKeyRepository,
    ProviderKeyService,
    ProviderRouter,
    RunAccessConsumer,
    RunControl,
    RunExecutorRegistry,
    RunLineService,
    RunQueueConsumer,
    RunReaper,
    RunService,
    RunStore,
    RunStreamPublisher,
    RunStreamReader,
    ScriptedExecutor,
  ],
})
export class AgentModule {}
