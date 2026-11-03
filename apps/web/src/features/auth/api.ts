import {
  type BeginTotpEnrolmentResponse,
  type ChangePasswordRequest,
  type ConfirmTotpEnrolmentRequest,
  type ConfirmTotpEnrolmentResponse,
  type CurrentUserResponse,
  type LoginRequest,
  type LoginResponse,
  type MfaChallengeRequest,
  type OauthProvider,
  type RequestPasswordResetRequest,
  type ResendVerificationRequest,
  type ResetPasswordRequest,
  type SessionListResponse,
  type SignedInResponse,
  type SignupRequest,
  type StepUpRequest,
  type VerifyEmailRequest,
  beginTotpEnrolmentResponseSchema,
  changePasswordRequestSchema,
  changePasswordResponseSchema,
  confirmTotpEnrolmentResponseSchema,
  currentUserResponseSchema,
  disableMfaResponseSchema,
  loginResponseSchema,
  mfaChallengeResponseSchema,
  oauthStartPath,
  requestPasswordResetResponseSchema,
  resendVerificationResponseSchema,
  resetPasswordResponseSchema,
  revokeSessionResponseSchema,
  sessionListResponseSchema,
  signupResponseSchema,
  stepUpResponseSchema,
  verifyEmailResponseSchema,
} from '@repo/contracts';
import { joinUrl } from '@repo/utils';

import { TURNSTILE_HEADER, apiRequest } from '@/lib/api/client';
import { env } from '@/lib/env';

/**
 * One function per endpoint, each naming its contract schema.
 *
 * The request types come from the same package the API validates against, so a body this app sends
 * and a body the API accepts cannot drift apart without one of the two failing to compile.
 */

/**
 * The anti-automation token, on the two routes `TurnstileGuard` protects.
 *
 * A header rather than a body field, because that is where the guard reads it — and the guard's own
 * comment explains why: every one of these request schemas is a `strictObject`, so a token in the
 * body would be a `422` before the guard ever saw it. `undefined` on a deployment with no site key,
 * which is every developer machine, and the guard is inert there too.
 */
function turnstileHeaders(token: string | undefined): Record<string, string> {
  return token === undefined ? {} : { [TURNSTILE_HEADER]: token };
}

export async function signUp(body: SignupRequest, turnstileToken?: string): Promise<void> {
  await apiRequest('POST', '/auth/signup', {
    body,
    headers: turnstileHeaders(turnstileToken),
    schema: signupResponseSchema,
  });
}

export async function verifyEmail(body: VerifyEmailRequest): Promise<void> {
  await apiRequest('POST', '/auth/verify', { body, schema: verifyEmailResponseSchema });
}

export async function resendVerification(body: ResendVerificationRequest): Promise<void> {
  await apiRequest('POST', '/auth/verify/resend', {
    body,
    schema: resendVerificationResponseSchema,
  });
}

/**
 * The password leg of a sign-in, in both states criterion 4 allows it to end in.
 *
 * The union is returned as it arrived rather than being flattened into a boolean, because the two
 * arms carry different data — one names the account and the other deliberately says nothing at all.
 */
export async function signIn(body: LoginRequest): Promise<LoginResponse> {
  return apiRequest('POST', '/auth/login', { body, schema: loginResponseSchema });
}

export async function completeMfaChallenge(body: MfaChallengeRequest): Promise<SignedInResponse> {
  return apiRequest('POST', '/auth/mfa/challenge', { body, schema: mfaChallengeResponseSchema });
}

/** `204`, and idempotent: the route is `@Public()` so a dead cookie still gets cleared. */
export async function signOut(): Promise<void> {
  await apiRequest('POST', '/auth/logout');
}

/**
 * Who the session cookie resolves to, or a thrown `unauthorized` when it resolves to nobody.
 *
 * The refusal is the answer here rather than an error to be smoothed over — `me.ts` chose a 401
 * over "a 200 carrying an empty user" precisely so a client cannot mistake "not signed in" for
 * "signed in as nobody".
 */
export async function getCurrentUser(signal?: AbortSignal): Promise<CurrentUserResponse> {
  return apiRequest('GET', '/auth/me', { schema: currentUserResponseSchema, signal });
}

export async function requestPasswordReset(
  body: RequestPasswordResetRequest,
  turnstileToken?: string,
): Promise<void> {
  await apiRequest('POST', '/auth/password/reset', {
    body,
    headers: turnstileHeaders(turnstileToken),
    schema: requestPasswordResetResponseSchema,
  });
}

export async function resetPassword(body: ResetPasswordRequest): Promise<void> {
  await apiRequest('POST', '/auth/password/reset/confirm', {
    body,
    schema: resetPasswordResponseSchema,
  });
}

/**
 * No step-up: the current password in the body is the proof. Every *other* session is revoked;
 * this one survives, so the caller stays signed in.
 */
export async function changePassword(body: ChangePasswordRequest): Promise<void> {
  await apiRequest('POST', '/auth/password/change', {
    body: changePasswordRequestSchema.parse(body),
    schema: changePasswordResponseSchema,
  });
}

export async function listSessions(signal?: AbortSignal): Promise<SessionListResponse> {
  return apiRequest('GET', '/auth/sessions', { schema: sessionListResponseSchema, signal });
}

export async function revokeSession(id: string): Promise<void> {
  await apiRequest('DELETE', `/auth/sessions/${encodeURIComponent(id)}`, {
    schema: revokeSessionResponseSchema,
  });
}

/**
 * The four calls behind the two-factor dialog (spec 003), and none of them rotates the session —
 * `MfaController` is explicit that acquiring or removing a factor is not a privilege change.
 *
 * Only the two "read" shapes are returned. The provisioning URI and the recovery codes are the
 * two secrets this API ever hands a client, and a function that returned them is a function whose
 * result somebody eventually caches; both are consumed by the dialog and nothing else.
 */
export async function beginTotpEnrolment(): Promise<BeginTotpEnrolmentResponse> {
  return apiRequest('POST', '/auth/mfa/totp', { schema: beginTotpEnrolmentResponseSchema });
}

export async function confirmTotpEnrolment(
  body: ConfirmTotpEnrolmentRequest,
): Promise<ConfirmTotpEnrolmentResponse> {
  return apiRequest('POST', '/auth/mfa/totp/confirm', {
    body,
    schema: confirmTotpEnrolmentResponseSchema,
  });
}

export async function stepUp(body: StepUpRequest): Promise<void> {
  await apiRequest('POST', '/auth/mfa/step-up', { body, schema: stepUpResponseSchema });
}

export async function disableMfa(): Promise<void> {
  await apiRequest('DELETE', '/auth/mfa/totp', { schema: disableMfaResponseSchema });
}

/**
 * Where the browser is sent to begin an OAuth sign-in.
 *
 * A URL to navigate to, not something to `fetch`. The route answers `302` to the provider, and an
 * XHR would either follow it into a cross-origin page it cannot read or be blocked outright — in
 * both cases without the browser ever visiting the provider, which is the entire point.
 *
 * `oauthStartPath` comes from the contract so the path is spelled once.
 */
export function oauthStartUrl(provider: OauthProvider): string {
  return joinUrl(env.VITE_API_URL, `/api/v1${oauthStartPath(provider)}`);
}
