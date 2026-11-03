import {
  addDomainRequestSchema,
  domainListResponseSchema,
  domainResponseSchema,
  removeDomainResponseSchema,
} from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../../common/validation/zod-dto';

/**
 * contracts/domains.md: the add body (strict — an undeclared key is a `422` from the
 * application-wide pipe), the two response bodies of US1 and the removal's of US2.
 */
@ApiZodSchema()
export class AddDomainRequestDto extends createZodDto(addDomainRequestSchema) {}

@ApiZodSchema()
export class DomainResponseDto extends createZodDto(domainResponseSchema) {}

@ApiZodSchema()
export class DomainListResponseDto extends createZodDto(domainListResponseSchema) {}

@ApiZodSchema()
export class RemoveDomainResponseDto extends createZodDto(removeDomainResponseSchema) {}
