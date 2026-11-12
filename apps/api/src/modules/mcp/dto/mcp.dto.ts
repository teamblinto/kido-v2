import {
  mcpAuthorizationDecisionSchema,
  mcpAuthorizationPreviewSchema,
  mcpAuthorizationRedirectSchema,
  mcpAuthorizationRequestSchema,
  mcpGrantListSchema,
} from '@repo/contracts';

import { ApiZodSchema, createZodDto } from '../../../common/validation/zod-dto';

@ApiZodSchema()
export class McpAuthorizationRequestDto extends createZodDto(mcpAuthorizationRequestSchema) {}

@ApiZodSchema()
export class McpAuthorizationPreviewDto extends createZodDto(mcpAuthorizationPreviewSchema) {}

@ApiZodSchema()
export class McpAuthorizationDecisionDto extends createZodDto(mcpAuthorizationDecisionSchema) {}

@ApiZodSchema()
export class McpAuthorizationRedirectDto extends createZodDto(mcpAuthorizationRedirectSchema) {}

@ApiZodSchema()
export class McpGrantListDto extends createZodDto(mcpGrantListSchema) {}
