import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 3;

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  INSERT OR IGNORE INTO metadata(key, value) VALUES
    ('revision', '0'),
    ('index_revision', '0');

  CREATE TABLE IF NOT EXISTS idempotency_keys (
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY(operation, idempotency_key)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS source_events (
    event_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    origin_revision INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    selected_evidence INTEGER NOT NULL CHECK(selected_evidence IN (0, 1)),
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS source_events_scope_idx
    ON source_events(user_id, workspace_id, session_id, captured_at);
  CREATE INDEX IF NOT EXISTS source_events_revision_idx ON source_events(revision);

  CREATE VIRTUAL TABLE IF NOT EXISTS source_events_fts USING fts5(
    event_id UNINDEXED,
    user_id UNINDEXED,
    workspace_id UNINDEXED,
    content,
    tokenize='unicode61 remove_diacritics 2'
  );

  CREATE TABLE IF NOT EXISTS turns (
    turn_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    agent_profile_key TEXT NOT NULL,
    snapshot_revision INTEGER NOT NULL,
    gate_satisfied INTEGER NOT NULL CHECK(gate_satisfied IN (0, 1)),
    retry_count INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    encrypted_plan TEXT NOT NULL,
    record_hash TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS turns_scope_idx ON turns(user_id, workspace_id, session_id, created_at);

  CREATE TABLE IF NOT EXISTS observations (
    observation_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    turn_id TEXT NOT NULL REFERENCES turns(turn_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    kind TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS observations_turn_idx ON observations(turn_id, created_at);

  CREATE TABLE IF NOT EXISTS world_claims (
    claim_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    status TEXT NOT NULL,
    authority TEXT NOT NULL,
    confidence REAL NOT NULL,
    supersedes TEXT,
    conflict_group TEXT,
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    PRIMARY KEY(claim_id, version)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS world_claims_scope_idx
    ON world_claims(user_id, workspace_id, session_id, status, revision);

  CREATE VIRTUAL TABLE IF NOT EXISTS world_claims_fts USING fts5(
    row_key UNINDEXED,
    user_id UNINDEXED,
    workspace_id UNINDEXED,
    subject,
    predicate,
    value,
    tokenize='unicode61 remove_diacritics 2'
  );

  CREATE TABLE IF NOT EXISTS policies (
    policy_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    scope_level TEXT NOT NULL,
    authority TEXT NOT NULL,
    review_status TEXT NOT NULL,
    text TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    PRIMARY KEY(policy_id, version)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS policies_scope_idx
    ON policies(user_id, workspace_id, session_id, review_status, revision);

  CREATE VIRTUAL TABLE IF NOT EXISTS policies_fts USING fts5(
    row_key UNINDEXED,
    user_id UNINDEXED,
    workspace_id UNINDEXED,
    text,
    tokenize='unicode61 remove_diacritics 2'
  );

  CREATE TABLE IF NOT EXISTS episodes (
    episode_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    title TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS episodes_scope_idx
    ON episodes(user_id, workspace_id, session_id, ended_at);

  CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
    episode_id UNINDEXED,
    user_id UNINDEXED,
    workspace_id UNINDEXED,
    title,
    summary,
    tokenize='unicode61 remove_diacritics 2'
  );

  CREATE TABLE IF NOT EXISTS corrections (
    correction_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    turn_id TEXT NOT NULL REFERENCES turns(turn_id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    kind TEXT NOT NULL,
    explicit INTEGER NOT NULL CHECK(explicit IN (0, 1)),
    created_at TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS corrections_scope_idx
    ON corrections(user_id, workspace_id, session_id, created_at);

  CREATE TABLE IF NOT EXISTS turn_traces (
    trace_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    turn_id TEXT NOT NULL REFERENCES turns(turn_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    created_at TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS turn_traces_turn_idx ON turn_traces(turn_id, created_at);

  CREATE TABLE IF NOT EXISTS triggers (
    trigger_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    policy_id TEXT,
    risk_code TEXT,
    priority REAL NOT NULL,
    activation_count INTEGER NOT NULL,
    last_activated_at TEXT,
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS failure_clusters (
    cluster_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    status TEXT NOT NULL,
    correction_count INTEGER NOT NULL,
    session_count INTEGER NOT NULL,
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS calibration_patterns (
    pattern_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    agent_profile_key TEXT NOT NULL,
    status TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS calibration_agent_idx
    ON calibration_patterns(agent_profile_key, status);

  CREATE TABLE IF NOT EXISTS source_links (
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    event_id TEXT NOT NULL REFERENCES source_events(event_id) ON DELETE CASCADE,
    PRIMARY KEY(owner_type, owner_id, event_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS source_links_event_idx ON source_links(event_id);

  CREATE TABLE IF NOT EXISTS entity_edges (
    edge_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    from_type TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_type TEXT NOT NULL,
    to_id TEXT NOT NULL,
    relation TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS embeddings (
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    vector BLOB NOT NULL,
    PRIMARY KEY(owner_type, owner_id, provider, model)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS cache_entries (
    cache_key TEXT PRIMARY KEY,
    owner_type TEXT,
    owner_id TEXT,
    expires_at TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS tombstones (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    deleted_at TEXT NOT NULL,
    PRIMARY KEY(entity_type, entity_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS tombstones_scope_idx
    ON tombstones(user_id, workspace_id, session_id, revision);
  `,
  `
  ALTER TABLE tombstones ADD COLUMN reason TEXT;
  `,
  `
  ALTER TABLE turns ADD COLUMN branch TEXT;
  ALTER TABLE turns ADD COLUMN commit_hash TEXT;
  `,
];

export function migrate(database: Database.Database): void {
  const current = database.pragma("user_version", { simple: true }) as number;
  if (current > SCHEMA_VERSION) {
    throw new Error(`Database schema ${current} is newer than supported schema ${SCHEMA_VERSION}`);
  }

  for (let version = current + 1; version <= SCHEMA_VERSION; version += 1) {
    const sql = MIGRATIONS[version - 1];
    if (!sql) throw new Error(`Missing database migration ${version}`);
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(sql);
      database.pragma(`user_version = ${version}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
