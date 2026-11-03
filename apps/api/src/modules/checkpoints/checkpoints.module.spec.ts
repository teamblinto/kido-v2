import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { AuditModule } from '../audit/audit.module';
import { OutboxModule } from '../outbox/outbox.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { CheckpointRepository } from './checkpoint.repository';
import { CheckpointService } from './checkpoint.service';
import { CheckpointsModule } from './checkpoints.module';
import { CheckpointsController } from './controllers/checkpoints.controller';
import { FileWriteController } from './controllers/file-write.controller';
import { RepoBundler } from './repo-bundler';

/** Read off the module metadata, as `agent.module.spec.ts` does: the declaration is the invariant. */
describe('CheckpointsModule', () => {
  const providers = Reflect.getMetadata('providers', CheckpointsModule) as unknown[];

  it('imports sandbox, outbox and audit — the three edges in the graph (plan § Constitution I)', () => {
    expect(Reflect.getMetadata('imports', CheckpointsModule)).toEqual([
      AuditModule,
      OutboxModule,
      SandboxModule,
    ]);
  });

  it('provides and exports the repository, the service and the bundler (018 R5)', () => {
    expect(providers).toContain(CheckpointRepository);
    expect(providers).toContain(CheckpointService);
    expect(providers).toContain(RepoBundler);
    expect(Reflect.getMetadata('exports', CheckpointsModule)).toEqual([
      CheckpointRepository,
      CheckpointService,
      RepoBundler,
    ]);
  });

  /** Constitution III: the global guard chain is `identity`'s and `rbac`'s; no module re-registers one. */
  it('registers its two controllers and no guard or interceptor of its own', () => {
    expect(Reflect.getMetadata('controllers', CheckpointsModule)).toEqual([
      CheckpointsController,
      FileWriteController,
    ]);
    expect(providers).not.toContain(APP_GUARD);
    expect(providers).not.toContain(APP_INTERCEPTOR);
  });

  it('compiles with the repository alone: it needs nothing injected', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [CheckpointRepository],
    }).compile();

    expect(moduleRef.get(CheckpointRepository)).toBeInstanceOf(CheckpointRepository);
  });
});
