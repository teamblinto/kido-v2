import { fileListResponseSchema, filePathQuerySchema, wakeResponseSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** The query both read routes share: a jailed, relative path, `''` for the root (contract § 1). */
@ApiZodSchema()
export class FilePathQueryDto extends createZodDto(filePathQuerySchema) {}

/**
 * `fileContentResponseSchema` has no DTO: it is a discriminated union, and `createZodDto` builds a
 * class, which a union of two shapes cannot be extended from. The route documents both branches in
 * prose instead — the schema itself still guards the wire in `files.controller.spec.ts`.
 */
@ApiZodSchema()
export class FileListResponseDto extends createZodDto(fileListResponseSchema) {}

@ApiZodSchema()
export class WakeResponseDto extends createZodDto(wakeResponseSchema) {}
