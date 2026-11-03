import { Inject, Injectable, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { validateEnvironment } from '../../../config/environment';
import { BREACHED_PASSWORD_PORT, type BreachedPasswordPort } from './breached-password.port';
import { PasswordHasher } from './hasher';
import { HibpAdapter } from './hibp.adapter';
import { PasswordModule } from './password.module';
import { PasswordStrengthPolicy } from './strength-policy';

@Injectable()
class Consumer {
  constructor(
    @Inject(BREACHED_PASSWORD_PORT) readonly breached: BreachedPasswordPort,
    readonly hasher: PasswordHasher,
    readonly strength: PasswordStrengthPolicy,
  ) {}
}

@Module({ imports: [PasswordModule], providers: [Consumer] })
class ConsumerModule {}

async function compile() {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true, validate: validateEnvironment }),
      ConsumerModule,
    ],
  }).compile();
}

describe('PasswordModule', () => {
  /**
   * The binding is the point: `BreachedPasswordPort` is what a service depends on, and HIBP is one
   * implementation of it. Asserting the token resolves to the adapter is what stops the port from
   * being a comment.
   */
  it('binds the breached-password port to the HIBP adapter', async () => {
    const moduleRef = await compile();

    expect(
      moduleRef.get<BreachedPasswordPort>(BREACHED_PASSWORD_PORT, { strict: false }),
    ).toBeInstanceOf(HibpAdapter);
  });

  it('gives a consumer all three collaborators without it knowing the adapter', async () => {
    const consumer = (await compile()).get(Consumer, { strict: false });

    expect(consumer.breached).toBeInstanceOf(HibpAdapter);
    expect(consumer.hasher).toBeInstanceOf(PasswordHasher);
    expect(consumer.strength).toBeInstanceOf(PasswordStrengthPolicy);
  });

  /** Ranking the zxcvbn dictionaries and reading Argon2 configuration are once-per-process work. */
  it('provides singletons', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(PasswordHasher, { strict: false })).toBe(
      moduleRef.get(PasswordHasher, { strict: false }),
    );
  });
});
