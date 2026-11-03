import {
  cloudflareOfferSchema,
  completeInstallRequestSchema,
  connectionListSchema,
  githubConnectionSchema,
  installResponseSchema,
  operationSchema,
  pasteTokenRequestSchema,
  providerConnectionSchema,
  repositoryPageSchema,
  repositoryQuerySchema,
  supabaseCompleteRequestSchema,
  supabaseInstallResponseSchema,
} from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/**
 * Contracts § 1: the organisation connection's wire shapes. `connectionSchema` is a discriminated
 * union on `provider` since spec 030 (research R2), and `createZodDto` cannot extend a class from a
 * union, so each arm is its own DTO and a route answering either documents both with `oneOf`.
 */
@ApiZodSchema()
export class GithubConnectionResponseDto extends createZodDto(githubConnectionSchema) {}

@ApiZodSchema()
export class ProviderConnectionResponseDto extends createZodDto(providerConnectionSchema) {}

@ApiZodSchema()
export class ConnectionListResponseDto extends createZodDto(connectionListSchema) {}

@ApiZodSchema()
export class InstallResponseDto extends createZodDto(installResponseSchema) {}

/** `POST …/github/complete`: what GitHub's redirect carried back; strict, so a stray key is refused. */
@ApiZodSchema()
export class CompleteInstallRequestDto extends createZodDto(completeInstallRequestSchema) {}

/** `GET …/:connectionId/repositories?query=&cursor=`: one GitHub page, filtered by name. */
@ApiZodSchema()
export class RepositoryQueryDto extends createZodDto(repositoryQuerySchema) {}

@ApiZodSchema()
export class RepositoryPageResponseDto extends createZodDto(repositoryPageSchema) {}

/** Spec 030: `POST …/:provider/token` — strict, trimmed, 1..512, no inner whitespace. */
@ApiZodSchema()
export class PasteTokenRequestDto extends createZodDto(pasteTokenRequestSchema) {}

@ApiZodSchema()
export class SupabaseInstallResponseDto extends createZodDto(supabaseInstallResponseSchema) {}

/** `POST …/supabase/complete`: the code and state Supabase's redirect carried back. */
@ApiZodSchema()
export class SupabaseCompleteRequestDto extends createZodDto(supabaseCompleteRequestSchema) {}

/** Spec 030 contracts/bindings.md § 4. */
@ApiZodSchema()
export class OperationResponseDto extends createZodDto(operationSchema) {}

/** `GET …/domains/:domainId/cloudflare` (spec 030 contracts/bindings.md § 3). */
@ApiZodSchema()
export class CloudflareOfferResponseDto extends createZodDto(cloudflareOfferSchema) {}
