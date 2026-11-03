import * as relations from './relations';
import * as agent from './schema/agent';
import * as audit from './schema/audit';
import * as byok from './schema/byok';
import * as byos from './schema/byos';
import * as checkpoints from './schema/checkpoints';
import * as connectors from './schema/connectors';
import * as context from './schema/context';
import * as deploy from './schema/deploy';
import * as identity from './schema/identity';
import * as localAgent from './schema/local-agent';
import * as oauth from './schema/oauth';
import * as outbox from './schema/outbox';
import * as rbac from './schema/rbac';
import * as sandbox from './schema/sandbox';
import * as secrets from './schema/secrets';
import * as tenancy from './schema/tenancy';
import * as tokens from './schema/tokens';
import * as webhooks from './schema/webhooks';

export * from './relations';
export * from './schema/agent';
export * from './schema/audit';
export * from './schema/byok';
export * from './schema/byos';
export * from './schema/checkpoints';
export * from './schema/connectors';
export * from './schema/context';
export * from './schema/deploy';
export * from './schema/identity';
export * from './schema/local-agent';
export * from './schema/oauth';
export * from './schema/outbox';
export * from './schema/rbac';
export * from './schema/sandbox';
export * from './schema/secrets';
export * from './schema/tenancy';
export * from './schema/tokens';
export * from './schema/webhooks';

/** The shape of {@link schema}, for typing a Drizzle instance without importing the value. */
export type Schema = typeof schema;

/** Everything `drizzle(pool, { schema })` needs, in one object. */
export const schema = {
  ...agent,
  ...audit,
  ...byok,
  ...byos,
  ...checkpoints,
  ...connectors,
  ...context,
  ...deploy,
  ...identity,
  ...localAgent,
  ...oauth,
  ...outbox,
  ...rbac,
  ...relations,
  ...sandbox,
  ...secrets,
  ...tenancy,
  ...tokens,
  ...webhooks,
};
