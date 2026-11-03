import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Desired = 'started' | 'stopped' | 'queued';

export interface SandboxRow {
  id: string;
  containerId: string | null;
  image: string;
  class: 'project' | 'agent' | 'build';
  labels: Record<string, string>;
  desired: Desired;
  networkAllow: string[] | null;
  networkBlockAll: boolean;
  createdAt: string;
}

type Raw = Record<string, string | number | null>;

const toRow = (r: Raw): SandboxRow => ({
  id: r.id as string,
  containerId: r.container_id as string | null,
  image: r.image as string,
  class: r.class as SandboxRow['class'],
  labels: JSON.parse(r.labels as string) as Record<string, string>,
  desired: r.desired as Desired,
  networkAllow:
    r.network_allow === null ? null : (JSON.parse(r.network_allow as string) as string[]),
  networkBlockAll: r.network_block_all === 1,
  createdAt: r.created_at as string,
});

export class Store {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'sandboxd.db'));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sandbox (
        id TEXT PRIMARY KEY, container_id TEXT, image TEXT NOT NULL, class TEXT NOT NULL,
        labels TEXT NOT NULL, desired TEXT NOT NULL, network_allow TEXT,
        network_block_all INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        sandbox_id TEXT NOT NULL, session_id TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (sandbox_id, session_id))`);
  }

  insert(r: SandboxRow): void {
    this.db
      // Named columns: databases created before queued_at was dropped still have it (nullable).
      .prepare(
        'INSERT INTO sandbox (id, container_id, image, class, labels, desired, network_allow, ' +
          'network_block_all, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        r.id,
        r.containerId,
        r.image,
        r.class,
        JSON.stringify(r.labels),
        r.desired,
        r.networkAllow === null ? null : JSON.stringify(r.networkAllow),
        r.networkBlockAll ? 1 : 0,
        r.createdAt,
      );
  }

  get(id: string): SandboxRow | undefined {
    const r = this.db.prepare('SELECT * FROM sandbox WHERE id=?').get(id) as Raw | undefined;
    return r && toRow(r);
  }

  all(): SandboxRow[] {
    return (this.db.prepare('SELECT * FROM sandbox ORDER BY created_at').all() as Raw[]).map(toRow);
  }

  // shortcut: filters in JS, fine for one node's few dozen sandboxes.
  byLabels(match: Record<string, string>): SandboxRow[] {
    return this.all().filter((r) => Object.entries(match).every(([k, v]) => r.labels[k] === v));
  }

  setLabels(id: string, labels: Record<string, string>): void {
    this.db.prepare('UPDATE sandbox SET labels=? WHERE id=?').run(JSON.stringify(labels), id);
  }

  setState(id: string, desired: Desired): void {
    this.db.prepare('UPDATE sandbox SET desired=? WHERE id=?').run(desired, id);
  }

  setNetwork(id: string, allow: string[] | null, blockAll: boolean): void {
    this.db
      .prepare('UPDATE sandbox SET network_allow=?, network_block_all=? WHERE id=?')
      .run(allow === null ? null : JSON.stringify(allow), blockAll ? 1 : 0, id);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM sandbox WHERE id=?').run(id);
    this.removeSessionsFor(id);
  }

  addSession(sandboxId: string, sessionId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO sessions VALUES (?,?,?)')
      .run(sandboxId, sessionId, new Date().toISOString());
  }

  hasSession(sandboxId: string, sessionId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM sessions WHERE sandbox_id=? AND session_id=?')
      .get(sandboxId, sessionId);
  }

  removeSession(sandboxId: string, sessionId: string): void {
    this.db
      .prepare('DELETE FROM sessions WHERE sandbox_id=? AND session_id=?')
      .run(sandboxId, sessionId);
  }

  removeSessionsFor(sandboxId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE sandbox_id=?').run(sandboxId);
  }

  close(): void {
    this.db.close();
  }
}
