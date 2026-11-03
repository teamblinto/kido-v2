import { Injectable } from '@nestjs/common';

import type { ClockPort } from './clock.port';

/** The production clock: the host clock, and the only place in `src/` allowed to call `new Date()`. */
@Injectable()
export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
}
