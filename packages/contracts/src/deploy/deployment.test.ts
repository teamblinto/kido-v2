import { describe, expect, it } from 'vitest';

import {
  DEPLOYMENT_FAILURE_REASONS,
  DEPLOYMENT_LOG_MAX_LENGTH,
  DEPLOYMENT_STATES,
  createDeploymentRequestSchema,
  deploymentListQuerySchema,
  deploymentListResponseSchema,
  deploymentLogResponseSchema,
  deploymentResponseSchema,
  deploymentSchema,
} from './deployment';

const UUID = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';
const SHA = 'a'.repeat(64);

const deployment = {
  artifactSha: null,
  attempts: 0,
  checkpointId: UUID,
  createdAt: '2026-09-22T10:00:00.000Z',
  current: false,
  failureReason: null,
  fileCount: null,
  finishedAt: null,
  id: UUID,
  requestedBy: UUID,
  startedAt: null,
  state: 'queued',
  totalBytes: null,
};

describe('deployment enums', () => {
  it('match contracts/deployments.md § Shapes exactly', () => {
    expect(DEPLOYMENT_STATES).toEqual([
      'queued',
      'building',
      'uploading',
      'succeeded',
      'failed',
      'cancelled',
    ]);
    expect(DEPLOYMENT_FAILURE_REASONS).toEqual([
      'install-failed',
      'build-failed',
      'no-output',
      'output-too-large',
      'timeout',
      'not-authorised',
      'platform',
    ]);
  });
});

describe('deploymentSchema', () => {
  it('accepts a queued deployment and a succeeded one', () => {
    expect(deploymentSchema.safeParse(deployment).success).toBe(true);
    expect(
      deploymentSchema.safeParse({
        ...deployment,
        artifactSha: SHA,
        current: true,
        fileCount: 12,
        finishedAt: '2026-09-22T10:02:00.000Z',
        startedAt: '2026-09-22T10:00:05.000Z',
        state: 'succeeded',
        totalBytes: 40_960,
      }).success,
    ).toBe(true);
  });

  it('refuses an undeclared key, including the log tail', () => {
    expect(deploymentSchema.safeParse({ ...deployment, extra: 1 }).success).toBe(false);
    expect(deploymentSchema.safeParse({ ...deployment, logTail: '' }).success).toBe(false);
  });

  it('requires artifactSha to be 64 lowercase hex', () => {
    expect(deploymentSchema.safeParse({ ...deployment, artifactSha: SHA }).success).toBe(true);
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), '']) {
      expect(deploymentSchema.safeParse({ ...deployment, artifactSha: bad }).success).toBe(false);
    }
  });

  it('refuses an unknown state or failure reason and negative attempts', () => {
    expect(deploymentSchema.safeParse({ ...deployment, state: 'running' }).success).toBe(false);
    expect(deploymentSchema.safeParse({ ...deployment, failureReason: 'oops' }).success).toBe(
      false,
    );
    expect(deploymentSchema.safeParse({ ...deployment, attempts: -1 }).success).toBe(false);
  });
});

describe('createDeploymentRequestSchema', () => {
  it('accepts an empty body (head checkpoint) or a checkpoint id', () => {
    expect(createDeploymentRequestSchema.safeParse({}).success).toBe(true);
    expect(createDeploymentRequestSchema.safeParse({ checkpointId: UUID }).success).toBe(true);
  });

  it('refuses an undeclared key and a non-uuid checkpoint', () => {
    expect(createDeploymentRequestSchema.safeParse({ checkpointId: UUID, x: 1 }).success).toBe(
      false,
    );
    expect(createDeploymentRequestSchema.safeParse({ checkpointId: 'head' }).success).toBe(false);
  });
});

describe('deployment responses', () => {
  it('wrap one deployment', () => {
    expect(deploymentResponseSchema.safeParse({ deployment }).success).toBe(true);
    expect(deploymentResponseSchema.safeParse({ deployment, extra: 1 }).success).toBe(false);
  });

  it('page on the shared cursor query', () => {
    expect(deploymentListQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(deploymentListQuerySchema.safeParse({ limt: '5' }).success).toBe(false);
    expect(
      deploymentListResponseSchema.safeParse({ items: [deployment], nextCursor: null }).success,
    ).toBe(true);
    expect(
      deploymentListResponseSchema.safeParse({ items: [], nextCursor: 'abc_-1' }).success,
    ).toBe(true);
    expect(deploymentListResponseSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it('cap the log at 64 KiB', () => {
    expect(DEPLOYMENT_LOG_MAX_LENGTH).toBe(65_536);
    expect(deploymentLogResponseSchema.safeParse({ log: '', truncated: false }).success).toBe(true);
    expect(
      deploymentLogResponseSchema.safeParse({ log: 'x'.repeat(65_536), truncated: true }).success,
    ).toBe(true);
    expect(
      deploymentLogResponseSchema.safeParse({ log: 'x'.repeat(65_537), truncated: true }).success,
    ).toBe(false);
    expect(deploymentLogResponseSchema.safeParse({ log: '' }).success).toBe(false);
  });
});
