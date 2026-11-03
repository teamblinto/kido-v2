import { SetMetadata } from '@nestjs/common';

/**
 * The metadata key `StepUpGuard` reads. A symbol rather than a string for the reason
 * `public.decorator.ts` gives: this is metadata attached to handlers across every module written
 * from here on, and a string key collides silently with any other decorator that picked the same
 * word — a collision that would read as "this route needs no second proof".
 */
export const REQUIRES_STEP_UP = Symbol('forge.identity.stepUp');

/**
 * Require a *recent* second factor on top of a session (§11, criterion 12).
 *
 * The session says who the caller is; this says they have proved it again within the last few
 * minutes. §11 names the routes: removing MFA, and — once they exist — billing, connector and
 * domain changes. Those are the changes an attacker holding a borrowed laptop would make, and they
 * are all changes whose damage outlives the session that made them.
 *
 * Note the default is the opposite of `@Public()`'s. Authentication is on unless a route opts out;
 * step-up is off unless a route opts in. That asymmetry is deliberate rather than an oversight: a
 * forgotten `@Public()` yields a 401 somebody reports, whereas a step-up demanded by default would
 * put a code prompt in front of every request in the application. The cost of forgetting this
 * decorator is real, so the list of routes that need it lives in §11 and in the criterion, not in
 * whatever a reviewer happens to remember.
 *
 * Applicable to a whole controller as well as a handler, because §11's list is controller-shaped
 * and per-handler marking is how one gets missed.
 */
export const StepUp = (): MethodDecorator & ClassDecorator => SetMetadata(REQUIRES_STEP_UP, true);
