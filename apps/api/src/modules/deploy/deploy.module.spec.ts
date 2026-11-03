import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { type Environment, environmentSchema } from '../../config/environment';
import { DeployModule } from './deploy.module';
import {
  CUSTOM_HOSTNAMES,
  type CustomHostnamePort,
  EdgeNotConfigured,
} from './domains/custom-hostname.port';
import { DNS, type DnsPort } from './domains/dns.port';
import { DomainRepository } from './domains/domain.repository';

/** Read off the module metadata, as `sandbox.module.spec.ts` does: the declaration is the invariant. */
describe('DeployModule domains (spec 028 T026)', () => {
  const providers = Reflect.getMetadata('providers', DeployModule) as unknown[];
  const tokenOf = (provider: unknown) =>
    typeof provider === 'object' && provider !== null && 'provide' in provider
      ? provider.provide
      : provider;
  const domainProviders = providers.filter((provider) =>
    [CUSTOM_HOSTNAMES, DNS, DomainRepository].includes(tokenOf(provider) as symbol),
  );

  it('binds the edge, DNS and the domain repository', () => {
    expect(domainProviders.map(tokenOf)).toEqual(
      expect.arrayContaining([CUSTOM_HOSTNAMES, DNS, DomainRepository]),
    );
  });

  it('resolves them with the CLOUDFLARE_* group absent, and the edge answers not configured', async () => {
    const environment = environmentSchema.parse({
      ...process.env,
      CLOUDFLARE_API_TOKEN: undefined,
      CLOUDFLARE_ZONE_ID: undefined,
      CUSTOM_HOSTNAME_TARGET: undefined,
    });
    expect(environment.CLOUDFLARE_API_TOKEN).toBeUndefined();

    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: ConfigService, useValue: new ConfigService<Environment, true>(environment) },
        ...(domainProviders as never[]),
      ],
    }).compile();

    expect(moduleRef.get(DomainRepository)).toBeInstanceOf(DomainRepository);
    expect(moduleRef.get<DnsPort>(DNS)).toBeDefined();

    const edge = moduleRef.get<CustomHostnamePort>(CUSTOM_HOSTNAMES);
    await expect(edge.register('app.acme.com')).rejects.toBeInstanceOf(EdgeNotConfigured);
    await expect(edge.status('edge-1')).rejects.toBeInstanceOf(EdgeNotConfigured);
    await expect(edge.findByHostname('app.acme.com')).rejects.toBeInstanceOf(EdgeNotConfigured);
    await expect(edge.deregister('edge-1')).rejects.toBeInstanceOf(EdgeNotConfigured);
  });
});
