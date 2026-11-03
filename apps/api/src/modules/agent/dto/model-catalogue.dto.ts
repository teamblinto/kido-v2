import { modelCatalogueResponseSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** `GET /api/v1/orgs/:orgId/models`: the organisation’s catalogue and its default (020 § 2). */
@ApiZodSchema()
export class ModelCatalogueResponseDto extends createZodDto(modelCatalogueResponseSchema) {}
