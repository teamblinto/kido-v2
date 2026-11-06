import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { OBJECT_STORE } from '../../common/object-store/object-store.port';
import { objectStoreFor } from '../../common/object-store/r2-object-store';
import type { Environment } from '../../config/environment';
import { AuditModule } from '../audit/audit.module';
import { OutboxModule } from '../outbox/outbox.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { CheckpointRepository } from './checkpoint.repository';
import { CheckpointService } from './checkpoint.service';
import { CheckpointsController } from './controllers/checkpoints.controller';
import { FileWriteController } from './controllers/file-write.controller';
import { RepoBundler } from './repo-bundler';
import { RepoMirrorConsumer } from './repo-mirror.consumer';
import { RepoMirrorSweep } from './repo-mirror-sweep';

/**
 * Checkpoints and revert (spec 016). `SandboxModule` for the port the git steps run through,
 * `OutboxModule` for the `checkpoint.created` event, `AuditModule` for the revert's trail; the
 * clock and the tenant transaction runner arrive from the global modules. The repository and the service are
 * exported for `agent`'s turn-end commit — the one edge that direction (research R4); the
 * bundler for `connectors`' push (018 R5).
 * `FileWriteController` answers on the `…/files` prefix (024 R1): a save is a checkpoint, so it
 * is served here rather than adding a `sandbox → checkpoints` edge for it.
 * `OBJECT_STORE` is chosen once at boot from the `OBJECT_STORE_*` variables (contracts § 7).
 */
@Module({
  controllers: [CheckpointsController, FileWriteController],
  exports: [CheckpointRepository, CheckpointService, RepoBundler],
  imports: [AuditModule, OutboxModule, SandboxModule],
  providers: [
    CheckpointRepository,
    CheckpointService,
    RepoBundler,
    RepoMirrorConsumer,
    RepoMirrorSweep,
    {
      inject: [ConfigService],
      provide: OBJECT_STORE,
      useFactory: (config: ConfigService<Environment, true>) => objectStoreFor(config, 'repos'),
    },
  ],
})
export class CheckpointsModule {}
