import {
  inspectImportRequestSchema,
  inspectImportResponseSchema,
  startImportRequestSchema,
  importMismatchResponseSchema,
} from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** Spec 026 contracts §§ 1–2. Both requests are `z.strictObject`: an undeclared key is a 422. */
@ApiZodSchema()
export class InspectImportRequestDto extends createZodDto(inspectImportRequestSchema) {}

@ApiZodSchema()
export class InspectImportResponseDto extends createZodDto(inspectImportResponseSchema) {}

@ApiZodSchema()
export class StartImportRequestDto extends createZodDto(startImportRequestSchema) {}

/** Contracts § 4: the FR-016 warning on the project's GitHub panel, null when they agree. */
@ApiZodSchema()
export class TemplateMismatchResponseDto extends createZodDto(importMismatchResponseSchema) {}
