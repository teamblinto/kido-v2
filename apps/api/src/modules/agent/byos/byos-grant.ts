import type { CredentialContext, KeyCheck, LlmProviderName } from '../llm-provider.port';

/** The adapters' bearer check (T008/T009), keyed by provider; the e2e suite may override it. */
export type BearerVerifiers = Record<
  LlmProviderName,
  { verifyBearer(credential: CredentialContext): Promise<KeyCheck> }
>;

export const BEARER_VERIFIERS = Symbol('forge.agent.byos.bearer-verifiers');

/** The purpose the grant is sealed under; with the user id it is the seal's AAD (R2, SC-004). */
export function grantPurpose(provider: LlmProviderName): string {
  return `byos:${provider}:grant`;
}
