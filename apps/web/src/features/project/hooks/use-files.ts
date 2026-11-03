import type {
  FileContentResponse,
  FileListResponse,
  WakeResponse,
  WriteFileRequest,
  WriteFileResponse,
} from '@repo/contracts';
import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useRef } from 'react';

import { ApiProblem } from '@/lib/api/problem';
import { listFiles, readFile, wakeSandbox, writeFile } from '../api';

/**
 * A refusal that means "the sandbox is asleep or on its way somewhere", not "this failed".
 *
 * The API answers it as a 409 from the frozen catalogue with an `extensions.kind` of
 * `sandbox-not-ready` (contracts/files.md § 1), which is the only part a client may branch on:
 * the slug is shared with every other conflict, so reading the status alone would put the wake
 * button in front of someone whose real problem is something else entirely.
 */
export function isAsleep(error: unknown): boolean {
  if (!ApiProblem.is(error, 'conflict')) {
    return false;
  }

  const extensions: unknown = error.detail?.extensions;

  return (
    typeof extensions === 'object' &&
    extensions !== null &&
    (extensions as { kind?: unknown }).kind === 'sandbox-not-ready'
  );
}

/** One directory of the working tree. `''` is the root, and `undefined` asks nothing. */
export function useDirectory(
  orgId: string | undefined,
  projectId: string | undefined,
  dir: string | undefined,
): UseQueryResult<FileListResponse> {
  return useQuery({
    enabled: orgId !== undefined && projectId !== undefined && dir !== undefined,
    queryFn: ({ signal }) => listFiles(orgId ?? '', projectId ?? '', dir ?? '', signal),
    queryKey: ['files', orgId, projectId, dir],
    // A sleeping sandbox is answered by the wake button, not by three more requests that will be
    // refused the same way.
    retry: (count, error) => !isAsleep(error) && count < 1,
  });
}

/** One file's bytes, or the reason there are none to render. */
export function useFile(
  orgId: string | undefined,
  projectId: string | undefined,
  path: string | undefined,
): UseQueryResult<FileContentResponse> {
  return useQuery({
    enabled:
      orgId !== undefined && projectId !== undefined && path !== undefined && path.length > 0,
    queryFn: ({ signal }) => readFile(orgId ?? '', projectId ?? '', path ?? '', signal),
    queryKey: ['file', orgId, projectId, path],
    retry: (count, error) => !isAsleep(error) && count < 1,
  });
}

/**
 * Ask the sandbox to wake.
 *
 * It answers rather than waits, so `{ ready: false, because: 'resuming' }` is the ordinary reply
 * and the caller keeps asking. Everything read out of the sandbox is invalidated on every reply,
 * including the not-yet-ready one: whichever call finally lands on `ready` is the one whose
 * invalidation refetches, and a stale tree behind a woken sandbox is the failure worth avoiding.
 * The preview goes with them (data-model.md), because it is served from the same sandbox.
 */
export function useWake(
  orgId: string | undefined,
  projectId: string | undefined,
): UseMutationResult<WakeResponse, Error, void> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => wakeSandbox(orgId ?? '', projectId ?? ''),
    onSuccess: async () => {
      await Promise.all(
        [
          ['files', orgId, projectId],
          ['file', orgId, projectId],
          ['preview', orgId, projectId],
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    },
  });
}

/**
 * Save one file (spec 024 contracts/file-write.md § 2).
 *
 * The key is minted here, once per path, and held until that path's save succeeds. That is what
 * makes a retry a retry: pressing save again after a refusal or a dropped connection sends the
 * same key, and the server answers with the first attempt's checkpoint rather than moving the
 * workspace twice — the same discipline `useRevert` applies per target.
 *
 * Two invalidations and no more. The open file, because a save is the one moment its bytes on
 * disk provably changed, and a refetch is also how the caller learns the *new* base to save
 * against next (contracts § 1). The checkpoint list, because a save lands as a row in it
 * (FR-009). The tree is untouched: a save writes an existing file and adds no entry.
 *
 * A refusal is not handled here. It reaches the caller as the `ApiProblem` the API sent, so the
 * view can put a sentence to it — and so US2's `base-moved` and US3's `run-active` have
 * somewhere to branch without this hook learning about either.
 */
export function useSaveFile(
  orgId: string | undefined,
  projectId: string | undefined,
): UseMutationResult<WriteFileResponse, Error, WriteFileRequest> {
  const queryClient = useQueryClient();
  const keys = useRef(new Map<string, string>());

  return useMutation({
    mutationFn: (input: WriteFileRequest) => {
      let key = keys.current.get(input.path);

      if (key === undefined) {
        key = crypto.randomUUID();
        keys.current.set(input.path, key);
      }

      return writeFile(orgId ?? '', projectId ?? '', input, key);
    },
    onSuccess: async (_response, input) => {
      keys.current.delete(input.path);

      await Promise.all(
        [
          ['file', orgId, projectId, input.path],
          ['checkpoints', orgId, projectId],
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    },
  });
}
