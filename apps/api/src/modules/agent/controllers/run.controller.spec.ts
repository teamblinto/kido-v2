import { describe, expect, it, vi } from 'vitest';

import type { TenantContext } from '../../../database/tenant-context';
import { REQUIRED_PERMISSION } from '../../rbac/decorators/require-permission.decorator';
import type { RunLineService } from '../run-line.service';
import type { RunService } from '../run.service';
import type { RunStreamReader } from '../run-stream-reader';
import { RunController } from './run.controller';

const ORG = 'c3400000-0000-4000-8000-000000000001';
const PROJECT = 'c3400000-0000-4000-8000-000000000002';
const TX = { tag: 'tx' } as unknown as TenantContext['tx'];

function permissionOf(method: keyof RunController): unknown {
  const handler = Object.getOwnPropertyDescriptor(RunController.prototype, method)!.value as object;

  return Reflect.getMetadata(REQUIRED_PERMISSION, handler);
}

describe('RunController', () => {
  it('GET …/runs/line answers the line on the tenant transaction, for project:read', async () => {
    const answer = { holder: null, waiting: [] };
    const read = vi.fn().mockResolvedValue(answer);
    const controller = new RunController(
      {} as RunService,
      {} as RunStreamReader,
      {} as never,
      { tx: TX } as TenantContext,
      { read } as unknown as RunLineService,
    );

    await expect(controller.line(ORG, PROJECT)).resolves.toBe(answer);
    expect(read).toHaveBeenCalledWith(TX, ORG, PROJECT);
    expect(permissionOf('line')).toMatchObject({ permission: 'project:read' });
  });

  it('keeps project:agent.run on start and cancel', () => {
    expect(permissionOf('create')).toMatchObject({ permission: 'project:agent.run' });
    expect(permissionOf('cancel')).toMatchObject({ permission: 'project:agent.run' });
  });
});
