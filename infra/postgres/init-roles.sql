-- Runs once, on first initialisation of the data volume, as the bootstrap superuser.
--
-- Three roles rather than two. FORCE ROW LEVEL SECURITY exists to make RLS apply to a
-- table's OWNER, so the role that owns the tables cannot also be the role that serves
-- requests -- otherwise every policy is bypassed by the thing it is meant to constrain.
--
--   forge_migrator  owns the schema, runs migrations, never serves a request
--   forge_app       the request path: no BYPASSRLS, subject to every policy
--   forge_bypass    cross-tenant work (exports, rollups -- not the outbox relay, which
--                   runs as forge_app because it needs an UPDATE), audited
--
-- Passwords here are local development placeholders and are not secrets. A real deployment
-- provisions these roles with credentials delivered as files (§11), never from a compose file.
--
-- Table-level grants are deliberately NOT set here. They belong with the schema that creates
-- the tables, so that append-only audit_log can be enforced by grant rather than convention.

CREATE ROLE forge_migrator LOGIN PASSWORD 'forge_migrator' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE forge_app      LOGIN PASSWORD 'forge_app'      NOSUPERUSER NOBYPASSRLS;
CREATE ROLE forge_bypass   LOGIN PASSWORD 'forge_bypass'   NOSUPERUSER BYPASSRLS;

-- Owning the database makes forge_migrator a member of pg_database_owner, which is what
-- owns the public schema from PostgreSQL 15 onwards -- so this is also what grants it CREATE.
ALTER DATABASE forge OWNER TO forge_migrator;

-- Created by the superuser so the migrator never needs the privilege.
-- citext: case-insensitive unique emails (Appendix A). pgcrypto: digest helpers.
-- pg_trgm: project and file search (§09). pgvector and pg_partman are later phases.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT CONNECT ON DATABASE forge TO forge_app, forge_bypass;
GRANT USAGE ON SCHEMA public TO forge_app, forge_bypass;
