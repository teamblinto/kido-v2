import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { IS_PUBLIC, Public } from './public.decorator';

const reflector = new Reflector();

@Public()
class WholeControllerIsOpen {
  handler(this: void): string {
    return 'handled';
  }
}

class MostlyClosedController {
  @Public()
  open(this: void): string {
    return 'open';
  }

  closed(this: void): string {
    return 'closed';
  }
}

describe('@Public', () => {
  it('marks a single handler', () => {
    expect(reflector.get(IS_PUBLIC, MostlyClosedController.prototype.open)).toBe(true);
  });

  it('marks every handler of a controller when applied to the class', () => {
    expect(reflector.get(IS_PUBLIC, WholeControllerIsOpen)).toBe(true);
  });

  /**
   * The default has to be "authenticated". A decorator that left undecorated handlers looking
   * public would turn `SessionGuard` from a global guard into an opt-in one, and the routes that
   * forgot to opt in are exactly the ones nobody is looking at.
   */
  it('leaves an undecorated handler unmarked', () => {
    expect(reflector.get(IS_PUBLIC, MostlyClosedController.prototype.closed)).toBeUndefined();
  });
});
