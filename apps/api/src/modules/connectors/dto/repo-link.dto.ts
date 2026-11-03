import { type PutRepoLinkRequest, putRepoLinkRequestSchema, repoLinkSchema } from '@repo/contracts';
import type { ZodType } from 'zod';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** Contracts § 2: the link row. */
@ApiZodSchema()
export class RepoLinkResponseDto extends createZodDto(repoLinkSchema) {}

/**
 * The `PUT` body's two arms as one static shape: a class cannot extend a union. The pipe
 * validates against the real union (`zodSchema`), so a body has exactly one arm at runtime and
 * the controller narrows it back to `PutRepoLinkRequest`.
 */
type PutRepoLinkBody = Partial<{
  create: Extract<PutRepoLinkRequest, { create: unknown }>['create'];
  existing: Extract<PutRepoLinkRequest, { existing: unknown }>['existing'];
}>;

@ApiZodSchema()
export class PutRepoLinkRequestDto extends createZodDto(
  putRepoLinkRequestSchema as unknown as ZodType<PutRepoLinkBody>,
) {}
