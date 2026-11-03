import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { SandboxModule } from '../sandbox/sandbox.module';
import {
  AGENT_TIMINGS,
  ANTHROPIC_TRANSPORT,
  DEFAULT_AGENT_TIMINGS,
  LLM_PROVIDER,
  RUN_EXECUTOR,
} from './agent.constants';
import { AgentModule } from './agent.module';
import { AgentExecutor } from './agent-executor';
import { AgentRunConsumer } from './agent-run.consumer';
import { AnthropicProvider } from './anthropic.adapter';
import { CatalogueService } from './byok/catalogue.service';
import { CredentialResolver } from './byok/credential-resolver';
import { ProviderKeyHealthConsumer } from './byok/provider-key-health.consumer';
import { ProviderKeyRepository } from './byok/provider-key.repository';
import { KEY_VERIFIERS, ProviderKeyService } from './byok/provider-key.service';
import { LinkedAccountController } from './controllers/linked-account.controller';
import { ModelsController } from './controllers/models.controller';
import { ProviderKeyController } from './controllers/provider-key.controller';
import { OpenAiProvider } from './openai.adapter';
import { PlatformCredentials } from './platform-credentials';
import { ProviderRouter } from './provider-router';
import { RunController } from './controllers/run.controller';
import { REQUIRED_PERMISSION } from '../rbac/decorators/require-permission.decorator';
import { RunControl } from './run-control';
import { RunReaper } from './run-reaper';
import { RunStreamPublisher } from './run-stream-publisher';
import { ScriptedExecutor } from './scripted-executor';
import { DEFAULT_STREAM_TIMINGS, STREAM_TIMINGS } from './stream.constants';

import { IdentityModule } from '../identity/identity.module';
import { ByosMailConsumer } from './byos/byos-mail.consumer';
import { ByosProviders } from './byos/byos-providers';
import { SUBSCRIPTION_CLIENTS } from './byos/subscription-client.port';

/**
 * Read off the module metadata, as `rbac.module.spec.ts` does for its guard: the declaration is
 * the invariant, and it holds without booting the container.
 */
describe('AgentModule', () => {
  const providers = Reflect.getMetadata('providers', AgentModule) as unknown[];

  it('binds RUN_EXECUTOR to AgentExecutor', () => {
    expect(providers).toContainEqual({ provide: RUN_EXECUTOR, useClass: AgentExecutor });
    expect(providers).toContain(AgentExecutor);
  });

  it('binds LLM_PROVIDER to ProviderRouter over both adapters (020)', () => {
    expect(providers).toContainEqual({ provide: LLM_PROVIDER, useExisting: ProviderRouter });
    expect(providers).toContain(ProviderRouter);
    expect(providers).toContain(AnthropicProvider);
    expect(providers).toContain(OpenAiProvider);
    const transport = providers.find(
      (provider: unknown) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === ANTHROPIC_TRANSPORT,
    ) as { useFactory: (config: { get: (key: string) => unknown }) => unknown } | undefined;
    expect(transport).toBeDefined();
    // Unset overrides leave the adapter on the SDK's own base URL and `globalThis.fetch`.
    expect(transport?.useFactory({ get: () => undefined })).toEqual({
      baseURL: undefined,
      fetch: undefined,
    });
  });

  /** Spec 032 T014: the BYOS mail consumer, and identity for its `noticeAddress` (R1). */
  it('registers the BYOS mail consumer and imports IdentityModule for its address', () => {
    expect(providers).toContain(ByosMailConsumer);
    expect(providers).toContain(ByosProviders);
    expect(Reflect.getMetadata('imports', AgentModule)).toContain(IdentityModule);
  });

  it('builds a subscription client only for a configured provider (032 R13)', () => {
    const entry = providers.find(
      (provider: unknown) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === SUBSCRIPTION_CLIENTS,
    ) as { useFactory: (providers: ByosProviders, config: unknown) => object } | undefined;
    const configured = {
      configuration: (provider: string) =>
        provider === 'openai'
          ? {
              apiBaseUrl: 'https://x.test',
              clientId: 'c',
              scopes: [],
              tokenUrl: 'https://x.test/t',
            }
          : undefined,
    } as unknown as ByosProviders;

    expect(Object.keys(entry!.useFactory(configured, { get: () => 10_000 }))).toEqual(['openai']);
  });

  it('imports SandboxModule', () => {
    expect(Reflect.getMetadata('imports', AgentModule)).toContain(SandboxModule);
  });

  /** The e2e suites override `RUN_EXECUTOR` with it (T028); it must still resolve. */
  it('still provides ScriptedExecutor', () => {
    expect(providers).toContain(ScriptedExecutor);
    expect(providers).not.toContainEqual({ provide: RUN_EXECUTOR, useClass: ScriptedExecutor });
  });

  it('binds the default timings under an overridable token', () => {
    expect(providers).toContainEqual({ provide: AGENT_TIMINGS, useValue: DEFAULT_AGENT_TIMINGS });
  });

  it('binds the stream timings under an overridable token and registers the publisher (009)', () => {
    expect(providers).toContainEqual({ provide: STREAM_TIMINGS, useValue: DEFAULT_STREAM_TIMINGS });
    expect(providers).toContain(RunStreamPublisher);
  });

  it('registers the consumer as an ordinary provider for QueueRegistry to discover', () => {
    expect(providers).toContain(AgentRunConsumer);
  });

  it('registers the reaper, which starts its interval at bootstrap when the outbox is on', () => {
    expect(providers).toContain(RunReaper);
  });

  it('registers the control channel, which subscribes at bootstrap when the outbox is on', () => {
    expect(providers).toContain(RunControl);
  });

  /** Constitution III: the global guard chain is `identity`'s and `rbac`'s; no module re-registers one. */
  it('registers no guard or interceptor of its own, so the guard order is untouched', () => {
    const tokens = providers.map((provider) =>
      typeof provider === 'object' && provider !== null && 'provide' in provider
        ? provider.provide
        : provider,
    );

    expect(tokens).not.toContain(APP_GUARD);
    expect(tokens).not.toContain(APP_INTERCEPTOR);
  });

  it('exposes the run routes, the model catalogue, the provider keys (020) and the linked accounts (032) on their own controllers', () => {
    expect(Reflect.getMetadata('controllers', AgentModule)).toEqual([
      LinkedAccountController,
      ModelsController,
      ProviderKeyController,
      RunController,
    ]);
  });

  it('provides KEY_VERIFIERS as the two adapters keyed by provider name, for ProviderKeyService (020 US1)', () => {
    expect(providers).toContain(ProviderKeyRepository);
    expect(providers).toContain(ProviderKeyService);
    const verifiers = providers.find(
      (provider: unknown) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === KEY_VERIFIERS,
    ) as { inject: unknown[]; useFactory: (a: unknown, b: unknown) => unknown } | undefined;
    expect(verifiers?.inject).toEqual([AnthropicProvider, OpenAiProvider]);
    expect(verifiers?.useFactory('A', 'O')).toEqual({ anthropic: 'A', openai: 'O' });
  });

  it('provides the resolver, the catalogue, the health sweep and PlatformCredentials behind them (020 T042)', () => {
    expect(providers).toContain(CredentialResolver);
    expect(providers).toContain(CatalogueService);
    expect(providers).toContain(ProviderKeyHealthConsumer);
    expect(providers).toContain(PlatformCredentials);
  });

  /**
   * Spec 009 US4 #4 (SC-004): the stream handler demands `project:read` like the run reads and
   * carries no `@UseGuards` of its own — the global chain is the only one. `'__guards__'` is
   * Nest's key for `@UseGuards`, written out for the reason `turnstile.guard.spec.ts` gives; the
   * positive assertion on `REQUIRED_PERMISSION` is what keeps the negative one from passing on a
   * misspelt handler name.
   */
  it('registers the stream route with no per-route guard', () => {
    const handler = Reflect.get(RunController.prototype, 'stream') as object;

    expect(Reflect.getMetadata(REQUIRED_PERMISSION, handler)).toEqual({
      param: 'projectId',
      permission: 'project:read',
    });
    expect(Reflect.getMetadata('__guards__', handler)).toBeUndefined();
  });
});
