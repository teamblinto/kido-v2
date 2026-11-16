/**
 * Spec 047: project names a person would have chosen. Pure — the naming consumer does the I/O.
 */

/** Words that say nothing about a project and are dropped from a generated name. */
const FILLER = new Set([
  'app',
  'repo',
  'project',
  'main',
  'master',
  'src',
  'code',
  'v1',
  'v2',
  'v3',
]);

const ACRONYMS = new Set([
  'ai',
  'api',
  'cli',
  'crm',
  'css',
  'html',
  'io',
  'llm',
  'mcp',
  'ml',
  'seo',
  'sql',
  'ui',
  'ux',
]);

/**
 * A repository or package name made readable: `acme-dashboard_v2` → "Acme Dashboard",
 * `@acme/web-app` → "Acme Web", `myAPIServer` → "My API Server". Never empty, at most 60 chars.
 */
export function humanizeName(raw: string): string {
  const words = raw
    .replace(/^@/, '')
    .replace(/[/_.\-\s]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(' ')
    .map((word) => word.trim())
    .filter((word) => word !== '');
  const kept = words.filter((word) => !FILLER.has(word.toLowerCase()));
  const chosen = (kept.length > 0 ? kept : words).slice(0, 5);
  const name = chosen
    .map((word) =>
      ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : /^[A-Z0-9]+$/.test(word) && word.length <= 4
          ? word
          : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(' ')
    .slice(0, 60)
    .trim();
  return name === '' ? 'Untitled project' : name;
}

/** The system prompt for one naming call: a short answer and nothing else. */
export const NAMING_SYSTEM_PROMPT =
  'You name software projects. Reply with only the name: 2 to 4 words, Title Case, no quotes, ' +
  'no punctuation at the end, no emoji. Make it specific and memorable, describing what the ' +
  'project does. Never use the words "App", "Project" or "AI-Powered" unless they are essential.';

/** The user turn for a naming call, from whatever describes the project, bounded. */
export function namingPrompt(hint: {
  readonly description?: string | null;
  readonly prompt?: string | null;
  readonly readme?: string | null;
  readonly repository?: string | null;
}): string {
  const parts = [
    hint.prompt ? `What the person asked to build:\n${hint.prompt.slice(0, 2000)}` : '',
    hint.repository ? `Repository: ${hint.repository}` : '',
    hint.description ? `Description: ${hint.description.slice(0, 500)}` : '',
    hint.readme ? `README excerpt:\n${hint.readme.slice(0, 2000)}` : '',
  ].filter((part) => part !== '');
  return `${parts.join('\n\n')}\n\nName this project.`;
}

/**
 * A model's answer as a project name, or null when it is not one: the first line, quotes and a
 * trailing full stop removed, 1–6 words and at most 60 characters.
 */
export function cleanGeneratedName(text: string): string | null {
  const line = text
    .trim()
    .split('\n')[0]!
    .replace(/^(name|project name)\s*:\s*/i, '')
    .replace(/[.!]+$/, '')
    .replace(/^["'`*_]+|["'`*_]+$/g, '')
    .replace(/[.!]+$/, '')
    .trim();
  const words = line.split(/\s+/).filter((word) => word !== '');
  if (words.length === 0 || words.length > 6 || line.length > 60) return null;
  return line;
}

/** The README's title and first paragraph: what a person would read to learn what this is. */
export function readmeExcerpt(readme: string | undefined): string | null {
  if (readme === undefined) return null;
  const lines = readme
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .split('\n')
    .map((line) => line.trim());
  const title = lines.find((line) => /^#\s+\S/.test(line))?.replace(/^#\s+/, '') ?? null;
  const paragraph = lines.find(
    (line) => line !== '' && !line.startsWith('#') && !line.startsWith('[') && line.length > 30,
  );
  const excerpt = [title, paragraph]
    .filter((part) => part !== null && part !== undefined)
    .join('\n');
  return excerpt === '' ? null : excerpt;
}
