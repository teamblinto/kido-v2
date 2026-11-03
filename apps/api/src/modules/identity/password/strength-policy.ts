import { Injectable } from '@nestjs/common';
import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import type { MatchExtended } from '@zxcvbn-ts/core';
import { adjacencyGraphs, dictionary as commonDictionary } from '@zxcvbn-ts/language-common';
import { dictionary as englishDictionary, translations } from '@zxcvbn-ts/language-en';

import { DomainError } from '../../../common/errors/domain-error';

/** What the policy is allowed to know about the person choosing the password. */
export interface PasswordOwner {
  readonly email?: string | null;
  readonly name?: string | null;
}

/**
 * zxcvbn scores 0–4. §11 asks for a "strength floor" without naming one; 3 is the library's
 * "safely unguessable" band — an offline attack at 10^10 guesses per second is out of reach — and
 * is the value the zxcvbn authors recommend for accounts that hold anything.
 */
export const STRENGTH_FLOOR = 3;

/**
 * How much of the password has to be the owner's own data before it counts as *derived from* it.
 *
 * Not "contains": `lovelace-quibble7-tundra!` mentions the owner and is still a strong password, and
 * rejecting it teaches users that the meter is arbitrary. At half or more, the personal token is
 * what the password is made of, and an attacker who knows the account's email is most of the way in.
 */
const PERSONAL_COVERAGE_FLOOR = 0.5;

/** Anything shorter matches inside almost every password and would misclassify unrelated ones. */
const MIN_USER_INPUT_LENGTH = 3;

export class WeakPasswordError extends DomainError {
  constructor(warning: string, suggestions: readonly string[], score = 0) {
    super('password-too-weak', 'This password is too easy to guess.', {
      score,
      suggestions: [...suggestions],
      warning,
    });
  }
}

export class PersonalInformationPasswordError extends DomainError {
  constructor() {
    super(
      'password-uses-personal-information',
      'This password is mostly your name or email address, which is the first thing an attacker tries.',
    );
  }
}

/**
 * The zxcvbn floor, plus the rule §11 asks for by passing the owner's own details as user inputs.
 *
 * The two rejections are deliberately independent rather than one being a diagnosis of the other.
 * `AdaLovelace1815` scores 3 — at the floor — and `Ada-Lovelace-forge` scores 4, so a policy that
 * asked "is the score too low, and if so why?" would accept both, which is precisely the case this
 * exists to stop. Personal information is checked first, and on its own terms.
 */
@Injectable()
export class PasswordStrengthPolicy {
  /**
   * One factory for the process. Building it ranks every dictionary in the language packs, which is
   * work worth doing once rather than per signup.
   */
  private readonly zxcvbn = new ZxcvbnFactory({
    dictionary: { ...commonDictionary, ...englishDictionary },
    graphs: adjacencyGraphs,
    translations,
  });

  /** Throws the rejection that tells the user what to fix, or returns silently. */
  assert(password: string, owner: PasswordOwner = {}): void {
    const result = this.zxcvbn.check(password, passwordUserInputs(owner));
    const covered = personalCoverage(result.sequence);

    // `covered > 0` and not only the ratio: an empty password covers nothing out of nothing, and
    // "your password is mostly your own name" is a nonsense answer to "you typed nothing".
    if (covered > 0 && covered >= password.length * PERSONAL_COVERAGE_FLOOR) {
      throw new PersonalInformationPasswordError();
    }

    if (result.score < STRENGTH_FLOOR) {
      throw new WeakPasswordError(
        result.feedback.warning ?? '',
        result.feedback.suggestions,
        result.score,
      );
    }
  }
}

/**
 * How many characters of the password zxcvbn explained with the owner's own data.
 *
 * The sequence is a non-overlapping segmentation of the password, so the matched spans add up
 * without double counting. An empty password has nothing to cover and is left to the floor.
 */
function personalCoverage(sequence: readonly MatchExtended[]): number {
  return sequence
    .filter((match) => match.pattern === 'dictionary' && match.dictionaryName === 'userInputs')
    .reduce((covered, match) => covered + (match.j - match.i + 1), 0);
}

/**
 * The tokens zxcvbn is told to treat as this account's own data.
 *
 * An email is split as well as passed whole, because zxcvbn matches a dictionary entry against a
 * substring of the password: `ada.lovelace@forge.dev` as one entry would never match `AdaLovelace1815`,
 * and the rule would quietly do nothing at all.
 */
export function passwordUserInputs(owner: PasswordOwner): string[] {
  const tokens: string[] = [];

  if (owner.email) {
    const email = owner.email.toLowerCase();
    // Split on the last `@`, and treat a value without one as all local part: validating the address
    // belongs to the contract layer, and throwing here would fail a signup over a value this
    // function was only asked to read.
    const at = email.lastIndexOf('@');
    const localPart = at === -1 ? email : email.slice(0, at);
    const domain = at === -1 ? '' : email.slice(at + 1);
    // A `+tag` is a routing detail of one address, not something about the person.
    const identity = localPart.replace(/\+.*$/, '');

    tokens.push(email, identity, ...identity.split(/[._-]/), ...domain.split('.'));
  }

  if (owner.name) {
    const name = owner.name.toLowerCase();

    tokens.push(name, ...name.split(/\s+/));
  }

  return [...new Set(tokens.filter((token) => token.length >= MIN_USER_INPUT_LENGTH))];
}
