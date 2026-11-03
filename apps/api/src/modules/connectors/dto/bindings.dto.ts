import {
  bindingListSchema,
  listingQuerySchema,
  neonBindRequestSchema,
  neonProjectPageSchema,
  netlifyBindRequestSchema,
  netlifyPublishRequestSchema,
  netlifySitePageSchema,
  operationPageSchema,
  operationQuerySchema,
  resendBindRequestSchema,
  resendDomainPageSchema,
  supabaseBindRequestSchema,
  supabaseProjectPageSchema,
} from '@repo/contracts';

import type { ZodType } from 'zod';

import { ApiZodSchema, createZodDto, type ZodDtoClass } from '../../../common/validation/zod-dto';

/** Spec 030 contracts/bindings.md § 2: the project's bindings, values never included. */
@ApiZodSchema()
export class BindingListResponseDto extends createZodDto(bindingListSchema) {}

/** `PUT …/connectors/neon`. */
@ApiZodSchema()
export class NeonBindRequestDto extends createZodDto(neonBindRequestSchema) {}

/** `PUT …/connectors/supabase`. */
@ApiZodSchema()
export class SupabaseBindRequestDto extends createZodDto(supabaseBindRequestSchema) {}

/** `PUT …/connectors/resend`. */
@ApiZodSchema()
export class ResendBindRequestDto extends createZodDto(resendBindRequestSchema) {}

@ApiZodSchema()
export class OperationQueryDto extends createZodDto(operationQuerySchema) {}

@ApiZodSchema()
export class OperationPageResponseDto extends createZodDto(operationPageSchema) {}

/** `GET …/:connectionId/<provider>/projects?q=`. */
@ApiZodSchema()
export class ProjectListingQueryDto extends createZodDto(listingQuerySchema) {}

@ApiZodSchema()
export class NeonProjectPageResponseDto extends createZodDto(neonProjectPageSchema) {}

@ApiZodSchema()
export class ResendDomainPageResponseDto extends createZodDto(resendDomainPageSchema) {}

@ApiZodSchema()
export class SupabaseProjectPageResponseDto extends createZodDto(supabaseProjectPageSchema) {}

/**
 * `PUT …/connectors/netlify`: `{ siteId }` or `{ createSite: { name } }`. A union's output is not
 * a class instance type, so the base is typed as a plain object; the pipe still parses the union.
 */
@ApiZodSchema()
export class NetlifyBindRequestDto extends (createZodDto(
  netlifyBindRequestSchema,
) as unknown as ZodDtoClass<ZodType<Record<string, unknown>>>) {}

/** `POST …/connectors/netlify/publish`. */
@ApiZodSchema()
export class NetlifyPublishRequestDto extends createZodDto(netlifyPublishRequestSchema) {}

@ApiZodSchema()
export class NetlifySitePageResponseDto extends createZodDto(netlifySitePageSchema) {}
