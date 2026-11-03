export interface Account {
  email: string;
  name: string;
}

/**
 * A project as the shelf renders it, derived from `ProjectSummary`.
 *
 * Deliberately no `status` and no `starred`. The API serves `{id, name, createdAt}` — §11 withholds
 * even the workspace id from a listing, so there is no lifecycle field to chip and nowhere to
 * record a preference. Both were rendered from mock data and were removed rather than faked: a
 * status that always read "ready" describes nothing, and a star that forgets on reload teaches a
 * user to distrust the controls that do work.
 */
export interface Project {
  /** Human phrasing of the only timestamp there is, e.g. "Created 2 hours ago". */
  activity: string;
  id: string;
  name: string;
}

/**
 * The tenant the sidebar is currently showing — an *organisation*, in the API's vocabulary.
 *
 * The two words collide, and this is the side that gives way. The API's `workspaces` are containers
 * inside an organisation and have no UI of their own in spec 001; what the sidebar switches between
 * is the organisations `GET /orgs` returns.
 */
export interface Workspace {
  id: string;
  name: string;
  /** Plan tier on its own, e.g. "Free" — the word "plan" is added by the caller. */
  plan: string;
  /** Seat summary, e.g. "1 member", or the caller's role where members are not readable. */
  seats: string;
}
