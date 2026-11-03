export const MINIMUM_PASSWORD_LENGTH = 12;

export type PasswordScore = 0 | 1 | 2 | 3 | 4;

export interface PasswordAssessment {
  /** True when the password matches a well-known breached credential. */
  isBreached: boolean;
  /** Short guidance rendered under the strength meter. */
  message: string;
  score: PasswordScore;
}

/**
 * A small sample of the most-leaked credentials. The real check is a
 * k-anonymity range query against the API; this only drives the UI states.
 */
const knownBreachedPasswords = new Set([
  '123456789012',
  'administrator',
  'iloveyou1234',
  'letmein12345',
  'password1234',
  'qwertyuiop12',
  'welcome12345',
]);

const characterClasses = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/];

/** Rough client-side strength estimate. Never a substitute for server-side scoring. */
export function assessPassword(password: string): PasswordAssessment {
  const normalised = password.toLowerCase();
  const isBreached = knownBreachedPasswords.has(normalised);

  if (password.length === 0) {
    return { isBreached: false, message: '', score: 0 };
  }

  const variety = characterClasses.filter((pattern) => pattern.test(password)).length;
  const hasRepeats = /(.)\1{2,}/.test(password);
  const wordCount = password.split(/[\s\-_.]+/).filter(Boolean).length;

  let raw = 0;
  if (password.length >= 8) raw += 1;
  if (password.length >= MINIMUM_PASSWORD_LENGTH) raw += 1;
  if (password.length >= 16) raw += 1;
  if (variety >= 3 || wordCount >= 3) raw += 1;
  if (hasRepeats) raw -= 1;
  // A breached password is weak no matter how it is built, but the meter still
  // shows one filled segment so the "weak" reading matches the rest of the scale.
  if (isBreached) raw = 1;

  const score = Math.min(4, Math.max(0, raw)) as PasswordScore;

  return { isBreached, message: describe(score, password.length), score };
}

function describe(score: PasswordScore, length: number): string {
  switch (score) {
    case 0:
    case 1:
      return `Weak — ${String(length)} characters. Try three unrelated words instead.`;
    case 2:
      return 'Fair — add length, or another unrelated word.';
    case 3:
      return 'Good — a little more length would make it strong.';
    case 4:
      return 'Strong — not found in any known breach';
  }
}
