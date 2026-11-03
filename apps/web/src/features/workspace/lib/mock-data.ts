/*
 * What is left of the workspace screen's placeholder content.
 *
 * The account, the workspace list and the project shelf now come from `GET /auth/me`, `GET /orgs`
 * and `GET /orgs/:orgId/projects`. What remains is not data the API withholds — it is editorial
 * copy with no server-side source and no reason to have one.
 */

/** Example prompts on the composer. Marketing copy, not a listing of anything. */
export const promptSuggestions: readonly string[] = [
  'Expense approvals',
  'Design QA tracker',
  'Vendor invoice parser',
  'Standup notes bot',
];
