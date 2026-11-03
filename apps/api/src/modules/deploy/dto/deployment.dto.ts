import {
  createDeploymentRequestSchema,
  deploymentListQuerySchema,
  deploymentListResponseSchema,
  deploymentLogResponseSchema,
  deploymentResponseSchema,
} from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

/**
 * contracts/deployments.md: the create body (strict — an undeclared key is a `422` from the
 * application-wide pipe), the page query, and the three response bodies.
 */
@ApiZodSchema()
export class CreateDeploymentRequestDto extends createZodDto(createDeploymentRequestSchema) {}

@ApiZodSchema()
export class DeploymentResponseDto extends createZodDto(deploymentResponseSchema) {}

@ApiZodSchema()
export class DeploymentListQueryDto extends createZodDto(deploymentListQuerySchema) {}

@ApiZodSchema()
export class DeploymentListResponseDto extends createZodDto(deploymentListResponseSchema) {}

@ApiZodSchema()
export class DeploymentLogResponseDto extends createZodDto(deploymentLogResponseSchema) {}
