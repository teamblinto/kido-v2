import { z } from 'zod';

import { PROBLEM_TYPES, type ProblemTypeSlug, problemTypeUri } from './problem-types';

/**
 * The wire shape of every error response. `requestId` is the §03 correlation id, carried as an
 * RFC 9457 extension member so a client can quote it without reading response headers.
 */
export const problemDetailSchema = z.looseObject({
  detail: z.string().min(1),
  instance: z.string().min(1),
  requestId: z.string().min(1),
  status: z.number().int().min(400).max(599),
  title: z.string().min(1),
  type: z.url(),
});

export type ProblemDetail = z.infer<typeof problemDetailSchema>;

export interface ProblemDetailInput {
  detail: string;
  extensions?: Readonly<Record<string, unknown>>;
  instance: string;
  requestId: string;
  type: ProblemTypeSlug;
}

/**
 * Build a problem document. `status`, `title` and `type` come from the frozen catalogue rather than
 * the caller, and extension members are spread first so none of them can shadow a reserved member.
 */
export function createProblemDetail(input: ProblemDetailInput): ProblemDetail {
  const definition = PROBLEM_TYPES[input.type];

  return {
    ...input.extensions,
    detail: input.detail,
    instance: input.instance,
    requestId: input.requestId,
    status: definition.status,
    title: definition.title,
    type: problemTypeUri(input.type),
  };
}
