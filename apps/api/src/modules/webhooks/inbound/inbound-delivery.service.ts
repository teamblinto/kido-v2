import { Inject, Injectable } from '@nestjs/common';

import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import {
  type DeliveryFailure,
  WebhookDeliveryRepository,
  type WebhookDeliveryRow,
} from './inbound-delivery.repository';

export type { DeliveryFailure, WebhookDeliveryRow };

/**
 * What another module may do with an inbound delivery (spec 029 T086, research R1).
 *
 * `connectors` processes GitHub deliveries but may not import this module's repository
 * (`no-foreign-repository`), so the consumer reads and settles a delivery through here. The
 * statements stay the repository's; this only binds them to the application database, which is
 * right for a platform table with no `org_id`.
 */
@Injectable()
export class InboundDeliveryService {
  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(WebhookDeliveryRepository) private readonly deliveries: WebhookDeliveryRepository,
  ) {}

  /** The delivery, or `null` when the retention sweep deleted it or it never existed. */
  async byId(id: string): Promise<WebhookDeliveryRow | null> {
    return (await this.deliveries.byId(this.db, id)) ?? null;
  }

  settle(
    id: string,
    state: WebhookDeliveryRow['state'],
    attempt: number,
    failure: DeliveryFailure | null = null,
  ): Promise<void> {
    return this.deliveries.settle(this.db, id, state, attempt, failure);
  }
}
