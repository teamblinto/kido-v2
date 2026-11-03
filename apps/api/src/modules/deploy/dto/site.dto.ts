import {
  siteResponseSchema,
  type UpdateSiteRequest,
  updateSiteRequestSchema,
} from '@repo/contracts';
import type { ZodType } from 'zod';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** contracts/deployments.md § site: the `{ site }` answer `GET` and `PUT` share. */
@ApiZodSchema()
export class SiteResponseDto extends createZodDto(siteResponseSchema) {}

/**
 * The `PUT` body's two arms as one static shape: a class cannot extend a union (the
 * `repo-link.dto.ts` precedent). The pipe validates against the real strict union (`zodSchema`), so
 * `release` without a `deploymentId` and `offline` with one are both `422`, and the controller
 * narrows the body back to `UpdateSiteRequest`.
 */
interface UpdateSiteBody {
  action: UpdateSiteRequest['action'];
  deploymentId?: string;
}

@ApiZodSchema()
export class UpdateSiteRequestDto extends createZodDto(
  updateSiteRequestSchema as unknown as ZodType<UpdateSiteBody>,
) {}
