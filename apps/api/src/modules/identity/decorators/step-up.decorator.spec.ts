import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { REQUIRES_STEP_UP, StepUp } from './step-up.decorator';

class BillingController {
  @StepUp()
  changePlan(this: void): string {
    return 'changed';
  }

  readPlan(this: void): string {
    return 'read';
  }
}

@StepUp()
class DomainsController {
  transfer(this: void): string {
    return 'transferred';
  }
}

describe('@StepUp()', () => {
  const reflector = new Reflector();

  it('marks the handler it decorates', () => {
    expect(reflector.get(REQUIRES_STEP_UP, BillingController.prototype.changePlan)).toBe(true);
  });

  /**
   * The default is *not* required, and that is the deliberate opposite of `@Public()`'s default.
   * Step-up is a friction the spec asks for on a named handful of routes (criterion 12); making it
   * the default would make every route in the application demand a code.
   */
  it('leaves an undecorated handler alone', () => {
    expect(reflector.get(REQUIRES_STEP_UP, BillingController.prototype.readPlan)).toBeUndefined();
  });

  /**
   * Applicable to a whole controller, because §11's list — billing, connectors, domains — is
   * controller-shaped, and marking each handler is how one gets forgotten.
   */
  it('marks every handler on a controller it decorates', () => {
    expect(reflector.get(REQUIRES_STEP_UP, DomainsController)).toBe(true);
  });
});
