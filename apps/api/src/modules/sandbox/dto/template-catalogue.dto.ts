import { templateCatalogueResponseSchema } from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/** `GET /api/v1/templates`: the deployment-wide template catalogue and its default. */
@ApiZodSchema()
export class TemplateCatalogueResponseDto extends createZodDto(templateCatalogueResponseSchema) {}
