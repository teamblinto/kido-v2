import { randomBytes } from 'node:crypto';

/**
 * A project's public site label (spec 027 research R10, FR-027): `{slug}-{suffix}`, where the slug
 * is the project name reduced to at most 40 of `[a-z0-9-]` and the suffix is 8 lowercase base32
 * characters (40 random bits). At most 49 characters, so always a DNS label, and always matching
 * `project_sites.site_label`'s rule `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`.
 *
 * The suffix is not a secret — deployed sites are public — it keeps two projects of the same name
 * from racing for one address. Uniqueness is the caller's: it retries on the unique index.
 *
 * The label must not contain, or be derivable from, the project's preview label (a capability).
 * The suffix is independent random bytes, and the only other input is the name, so the one way
 * in is a project *named* after its preview label: that slug is replaced with `site`. A preview
 * label is 32 hex characters with no hyphen, so it cannot straddle the `-` or fit in the suffix.
 */

/** Returns `size` random bytes. Injected so a spec can make the label deterministic. */
export type RandomSource = (size: number) => Buffer;

const MAX_SLUG = 40;
const FALLBACK_SLUG = 'site';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** The project name as at most 40 of `[a-z0-9-]`, with no leading, trailing or doubled hyphen. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
}

/** Five bytes as eight RFC 4648 base32 characters, lowercase, no padding. */
function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >>> bits) & 31];
    }
  }
  return out;
}

export function siteLabel(
  projectName: string,
  previewLabel: string,
  random: RandomSource = randomBytes,
): string {
  const slug = slugify(projectName);
  const safe = slug === '' || slug.includes(previewLabel) ? FALLBACK_SLUG : slug;
  return `${safe}-${base32(random(5))}`;
}
