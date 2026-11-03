import {
  providerKeyListSchema,
  providerKeySchema,
  putProviderKeyRequestSchema,
} from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../../common/validation/zod-dto';

/** Contracts § 1: the organisation provider key's wire shapes — never an `apiKey` on the way out. */
@ApiZodSchema()
export class ProviderKeyResponseDto extends createZodDto(providerKeySchema) {}

@ApiZodSchema()
export class ProviderKeyListResponseDto extends createZodDto(providerKeyListSchema) {}

/** `PUT …/:provider`: strict, so a stray key is refused; the provider prefix is the service's check. */
@ApiZodSchema()
export class PutProviderKeyRequestDto extends createZodDto(putProviderKeyRequestSchema) {}
