import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../../config/environment';
import { ConsoleMailer } from './console.mailer';
import { MAILER, type MailerPort } from './mailer.port';
import { ResendMailer } from './resend.mailer';

export class MissingMailConfigurationError extends Error {
  constructor(variable: keyof Environment, provider: string) {
    // The variable's name, never its value: this is a boot log line.
    super(`${variable} is required when MAIL_PROVIDER is ${JSON.stringify(provider)}.`);
    this.name = 'MissingMailConfigurationError';
  }
}

/**
 * Chooses the transport this deployment sends through.
 *
 * The environment schema already requires `RESEND_API_KEY` when the provider is Resend. It is
 * enforced again here for the reason `CryptoModule`'s factory gives: the schema guards the
 * *configured* path, and a container built by a test, a script or a module written next year
 * reaches none of it. Neither check is the other's fallback.
 *
 * `ConsoleMailer` additionally refuses to construct off a local deployment, so selecting it on
 * staging is a container that does not build rather than a fleet that silently sends no mail.
 */
export function mailerFor(config: ConfigService<Environment, true>): MailerPort {
  const provider = config.get('MAIL_PROVIDER', { infer: true });
  const from = config.get('MAIL_FROM', { infer: true });

  if (provider === 'resend') {
    const apiKey = config.get('RESEND_API_KEY', { infer: true });

    if (apiKey === undefined) {
      throw new MissingMailConfigurationError('RESEND_API_KEY', provider);
    }

    return new ResendMailer({ apiKey, from });
  }

  return new ConsoleMailer({ deployEnv: config.get('DEPLOY_ENV', { infer: true }), from });
}

/**
 * Outbound mail (spec 001 T11, ADR 004).
 *
 * `@Global` for the reason `AuditModule` gives. The importer list is signup, email verification,
 * password reset and invitations — four feature modules being written in four parallel lanes — and
 * a global provider means none of them has to edit its own module metadata to reach this, which is
 * one fewer edit each in the files most likely to conflict. Forgetting it has no silent fallback
 * either way: injection fails and the module does not build.
 *
 * The adapter is bound once, at boot, exactly as `CryptoModule` binds its KEK provider. Choosing it
 * per call would turn `ConsoleMailer`'s refusal into a per-request error rather than a deployment
 * that does not start.
 *
 * `InMemoryMailer` is deliberately not registered here, not even under `NODE_ENV=test`: a fake
 * selected by an environment variable is a fake that can be selected in production. Tests override
 * the {@link MAILER} provider instead.
 */
@Global()
@Module({
  exports: [MAILER],
  providers: [{ inject: [ConfigService], provide: MAILER, useFactory: mailerFor }],
})
export class MailModule {}
