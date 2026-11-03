import { z } from 'zod';

/** `GET /projects` — an org key's projects carry `org_id`; a project-scoped key's may not. */
export const neonProjectsSchema = z.object({
  projects: z.array(
    z.object({ id: z.string().min(1), name: z.string(), org_id: z.string().nullish() }),
  ),
});

const operationRef = z.object({ id: z.string().min(1), status: z.string() });

const branch = z.object({
  default: z.boolean().optional(),
  id: z.string().min(1),
  name: z.string(),
  parent_id: z.string().nullish(),
});

/** `GET /projects/{id}/branches[?search=]`. */
export const neonBranchesSchema = z.object({ branches: z.array(branch) });

/** `POST /projects/{id}/branches` and `DELETE …/branches/{bid}`: the branch and its operations. */
export const neonBranchMutationSchema = z.object({
  branch,
  operations: z.array(operationRef).default([]),
});

/** `GET /projects/{id}/operations/{op}`. */
export const neonOperationSchema = z.object({ operation: operationRef });

/** `GET /projects/{id}/connection_uri`. */
export const neonConnectionUriSchema = z.object({ uri: z.string().min(1) });

export const neonDatabasesSchema = z.object({
  databases: z.array(z.object({ name: z.string().min(1) })),
});

export const neonRolesSchema = z.object({ roles: z.array(z.object({ name: z.string().min(1) })) });
