import { oauthCallbackQuerySchema, oauthProviderParamsSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/**
 * The inbound halves of criterion 9's two routes, validated by the global `ZodValidationPipe` from
 * the schemas `@repo/contracts` publishes (ADR 010).
 *
 * The callback query is the only *loose* request shape in the API, and the reason is argued where
 * the schema is declared: GitHub and Google add members to that redirect on their own schedule, and
 * a strict schema would turn each addition into a `422` on a sign-in that was about to succeed.
 * Unknown members are dropped by the parse, so nothing a provider invents reaches a handler.
 */

/** The `:provider` segment of both routes. */
@ApiZodSchema()
export class OauthProviderParamsDto extends createZodDto(oauthProviderParamsSchema) {}

/** What the provider redirects the browser back with. */
@ApiZodSchema()
export class OauthCallbackQueryDto extends createZodDto(oauthCallbackQuerySchema) {}
