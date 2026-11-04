import { z } from 'zod';

/**
 * GitHub's responses, parsed against the members the connector reads (`looseObject`: the rest
 * passes through unread). Wire names here; `github-app.client.ts` maps to the module's own.
 */
export const installationSchema = z.looseObject({
  account: z.looseObject({
    id: z.number().int(),
    login: z.string().min(1),
    type: z.enum(['Organization', 'User']),
  }),
  id: z.number().int(),
});

export const accessTokenSchema = z.looseObject({
  expires_at: z.iso.datetime({ offset: true }),
  token: z.string().min(1),
});

export const repositorySchema = z.looseObject({
  default_branch: z.string().min(1),
  full_name: z.string().min(1),
  id: z.number().int(),
  name: z.string().min(1),
  owner: z.looseObject({ login: z.string().min(1) }),
  private: z.boolean(),
  /**
   * Spec 026 R6: the repository's size in KiB, the cheap gate the import checks before anything
   * is created. Optional because GitHub omits it on some payloads and an absent size must not
   * turn a readable repository into an unparseable one; absent reads as 0 and passes the gate.
   */
  size: z.number().int().nonnegative().optional(),
});

/**
 * `GET /repositories/{id}/git/trees/{sha}` — non-recursive, so only the root's entries (R3).
 * `truncated` is carried through: a truncated root is a root whose absent entries could have
 * changed the answer, and the inspector is told rather than guessing from a short list.
 */
export const treeSchema = z.looseObject({
  sha: z.string().min(1),
  tree: z.array(z.looseObject({ path: z.string(), type: z.string() })),
  truncated: z.boolean().optional(),
});

/** `GET /repositories/{id}/contents/{path}` for a file — base64 unless GitHub says otherwise. */
export const contentsSchema = z.looseObject({
  content: z.string(),
  encoding: z.string(),
});

export const repositoryPageSchema = z.looseObject({
  repositories: z.array(repositorySchema),
  total_count: z.number().int(),
});

export const branchSchema = z.looseObject({
  commit: z.looseObject({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
  name: z.string().min(1),
});

/** `GET /repositories/{id}/branches`: one page. */
export const branchPageSchema = z.array(
  z.looseObject({ name: z.string().min(1), protected: z.boolean() }),
);

/** Spec 044: `POST /login/oauth/access_token`. A refused code is a 200 with `error` and no token. */
export const userTokenSchema = z.looseObject({ access_token: z.string().min(1) });

export const userSchema = z.looseObject({ login: z.string().min(1) });
