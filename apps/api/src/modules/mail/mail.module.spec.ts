import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import type { Environment } from '../../config/environment';
import { ConsoleMailer, ConsoleMailerRefusedError } from './console.mailer';
import { MailModule, MissingMailConfigurationError } from './mail.module';
import { MAILER, type MailerPort } from './mailer.port';
import { ResendMailer } from './resend.mailer';

const API_KEY = 're_2vQx8LmT_9pKdZa4WsYb7NcRf1HgUj6E';

const CONSOLE_ENV = {
  APP_URL: 'http://localhost:5173',
  DEPLOY_ENV: 'local',
  MAIL_FROM: 'Forge <noreply@forge.dev>',
  MAIL_PROVIDER: 'console',
} as const;

const RESEND_ENV = {
  APP_URL: 'https://app.forge.dev',
  DEPLOY_ENV: 'production',
  MAIL_FROM: 'Forge <noreply@forge.dev>',
  MAIL_PROVIDER: 'resend',
  RESEND_API_KEY: API_KEY,
} as const;

/** Stands in for the global `ConfigModule` `AppModule` registers. Same shape `CryptoModule` uses. */
function configuring(values: Partial<Environment>) {
  @Global()
  @Module({
    exports: [ConfigService],
    providers: [
      { provide: ConfigService, useValue: { get: (key: keyof Environment) => values[key] } },
    ],
  })
  class FakeConfigModule {}

  return FakeConfigModule;
}

async function compile(values: Partial<Environment>) {
  return Test.createTestingModule({ imports: [configuring(values), MailModule] }).compile();
}

describe('MailModule adapter selection', () => {
  it('binds the console adapter when MAIL_PROVIDER is "console"', async () => {
    const moduleRef = await compile(CONSOLE_ENV);

    expect(moduleRef.get<MailerPort>(MAILER)).toBeInstanceOf(ConsoleMailer);
  });

  it('binds the Resend adapter when MAIL_PROVIDER is "resend"', async () => {
    const moduleRef = await compile(RESEND_ENV);

    expect(moduleRef.get<MailerPort>(MAILER)).toBeInstanceOf(ResendMailer);
  });

  it('shares one instance, so a mailer is not per-injection state', async () => {
    const moduleRef = await compile(CONSOLE_ENV);

    expect(moduleRef.get<MailerPort>(MAILER)).toBe(moduleRef.get<MailerPort>(MAILER));
  });

  /** Signup, verification, password reset and invitations all reach for this. */
  it('is global, so a consumer resolves the mailer without importing it', async () => {
    @Injectable()
    class NeedsTheMailer {
      constructor(@Inject(MAILER) readonly mailer: MailerPort) {}
    }

    @Module({ providers: [NeedsTheMailer] })
    class ConsumerModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [configuring(CONSOLE_ENV), MailModule, ConsumerModule],
    }).compile();

    expect(moduleRef.get(NeedsTheMailer, { strict: false }).mailer).toBeInstanceOf(ConsoleMailer);
  });
});

describe('MailModule with incomplete configuration', () => {
  /**
   * The environment schema already requires `RESEND_API_KEY` when the provider is Resend. Checked
   * again here for the reason `CryptoModule` gives: the schema guards the configured path, and a
   * container built by a test, a script or a module written next year reaches none of it.
   */
  it('refuses the Resend adapter with no api key', async () => {
    await expect(compile({ ...RESEND_ENV, RESEND_API_KEY: undefined })).rejects.toThrow(
      MissingMailConfigurationError,
    );
  });

  it('names the variable that is missing, and never its value', async () => {
    let caught: unknown;

    try {
      await compile({ ...RESEND_ENV, RESEND_API_KEY: undefined });
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).toContain('RESEND_API_KEY');
    expect(`${(caught as Error).message}${(caught as Error).stack ?? ''}`).not.toContain(API_KEY);
  });

  /**
   * A deployment that "sends" its mail into a log file is one where no user ever receives a
   * verification link and nothing reports a failure. Failing to boot is the loud version of that.
   */
  it.each(['staging', 'production'] as const)(
    'fails to build with the console adapter when DEPLOY_ENV is %s',
    async (deployEnv) => {
      await expect(compile({ ...CONSOLE_ENV, DEPLOY_ENV: deployEnv })).rejects.toThrow(
        ConsoleMailerRefusedError,
      );
    },
  );

  it('builds with the Resend adapter on a real deployment', async () => {
    await expect(compile(RESEND_ENV)).resolves.toBeDefined();
  });
});
