import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 7;

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
  `
  CREATE TABLE IF NOT EXISTS session_lifecycle (
    session_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('active', 'ended')),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    end_idempotency_key TEXT UNIQUE,
    record_hash TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS session_lifecycle_scope_idx
    ON session_lifecycle(user_id, workspace_id, status, revision);

  CREATE TABLE IF NOT EXISTS trigger_activations (
    activation_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    trigger_id TEXT NOT NULL,
    turn_id TEXT NOT NULL REFERENCES turns(turn_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    structural_score REAL NOT NULL,
    similarity_score REAL NOT NULL,
    effective_score REAL NOT NULL,
    activated_at TEXT NOT NULL,
    UNIQUE(trigger_id, turn_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS trigger_activations_trigger_idx
    ON trigger_activations(trigger_id, activated_at);

  CREATE TABLE IF NOT EXISTS learning_jobs (
    job_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
    attempts INTEGER NOT NULL,
    available_at TEXT NOT NULL,
    leased_at TEXT,
    last_error TEXT,
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS learning_jobs_queue_idx
    ON learning_jobs(status, available_at, revision);
  `,
  `
  CREATE TABLE IF NOT EXISTS embedding_buckets (
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    bucket TEXT NOT NULL,
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    PRIMARY KEY(provider, model, bucket, owner_type, owner_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS embedding_buckets_lookup_idx
    ON embedding_buckets(provider, model, bucket, owner_type, owner_id);
  CREATE INDEX IF NOT EXISTS embedding_buckets_owner_idx
    ON embedding_buckets(owner_type, owner_id, provider, model);
  `,
  `
  CREATE INDEX IF NOT EXISTS entity_edges_owner_idx
    ON entity_edges(to_type, to_id, relation);
  CREATE INDEX IF NOT EXISTS entity_edges_scope_from_idx
    ON entity_edges(user_id, workspace_id, from_type, from_id, to_type, to_id, relation);
  `,
  `
  INSERT OR IGNORE INTO metadata(key, value) VALUES
    ('memory_generation', '0');

  CREATE TABLE IF NOT EXISTS memory_scope_registry (
    user_id TEXT NOT NULL,
    workspace_key TEXT NOT NULL,
    workspace_id TEXT,
    last_activity_at TEXT NOT NULL,
    last_scheduled_at TEXT,
    PRIMARY KEY(user_id, workspace_key)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS memory_scope_registry_activity_idx
    ON memory_scope_registry(last_scheduled_at, last_activity_at DESC, user_id, workspace_key);
  INSERT OR IGNORE INTO memory_scope_registry(user_id, workspace_key, workspace_id, last_activity_at)
    SELECT user_id, COALESCE(workspace_id, ''), workspace_id, MAX(captured_at)
    FROM source_events
    GROUP BY user_id, workspace_id;

  CREATE TABLE IF NOT EXISTS memory_partitions (
    partition_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    namespace TEXT NOT NULL,
    partition_key TEXT NOT NULL,
    strategy TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'router', 'archived')),
    parent_partition_id TEXT,
    depth INTEGER NOT NULL,
    child_count INTEGER NOT NULL,
    object_count INTEGER NOT NULL,
    capacity INTEGER NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS memory_partitions_scope_idx
    ON memory_partitions(user_id, workspace_id, session_id, namespace, status, depth);
  CREATE INDEX IF NOT EXISTS memory_partitions_parent_idx
    ON memory_partitions(parent_partition_id, status);

  CREATE TABLE IF NOT EXISTS memory_objects (
    object_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    partition_id TEXT NOT NULL,
    parent_object_id TEXT,
    object_type TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'router', 'merged', 'deprecated', 'archived')),
    temperature TEXT NOT NULL CHECK(temperature IN ('hot', 'warm', 'cold', 'archive')),
    token_estimate INTEGER NOT NULL,
    child_count INTEGER NOT NULL,
    member_count INTEGER NOT NULL,
    confidence REAL NOT NULL,
    version INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    summarizer_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS memory_objects_scope_idx
    ON memory_objects(user_id, workspace_id, session_id, status, temperature, updated_at);
  CREATE INDEX IF NOT EXISTS memory_objects_partition_idx
    ON memory_objects(partition_id, status, temperature, updated_at);
  CREATE INDEX IF NOT EXISTS memory_objects_parent_idx
    ON memory_objects(parent_object_id, status);

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_objects_fts USING fts5(
    object_id UNINDEXED,
    partition_id UNINDEXED,
    user_id UNINDEXED,
    workspace_id UNINDEXED,
    title,
    summary,
    routing_keys,
    tokenize='unicode61 remove_diacritics 2'
  );

  CREATE TABLE IF NOT EXISTS memory_object_members (
    object_id TEXT NOT NULL,
    member_type TEXT NOT NULL,
    member_id TEXT NOT NULL,
    role TEXT NOT NULL,
    score REAL NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'removed')),
    revision INTEGER NOT NULL,
    added_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    origin_action_id TEXT,
    PRIMARY KEY(object_id, member_type, member_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS memory_object_members_member_idx
    ON memory_object_members(member_type, member_id, status, object_id);
  CREATE INDEX IF NOT EXISTS memory_object_members_object_idx
    ON memory_object_members(object_id, status, score DESC);

  CREATE TABLE IF NOT EXISTS memory_relations (
    relation_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    from_type TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_type TEXT NOT NULL,
    to_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'disputed', 'superseded', 'revoked')),
    confidence REAL NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS memory_relations_from_idx
    ON memory_relations(user_id, workspace_id, from_type, from_id, relation_type, status);
  CREATE INDEX IF NOT EXISTS memory_relations_to_idx
    ON memory_relations(user_id, workspace_id, to_type, to_id, relation_type, status);

  CREATE TABLE IF NOT EXISTS memory_versions (
    version_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    memory_type TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    operation TEXT NOT NULL,
    maintenance_action_id TEXT,
    created_at TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    UNIQUE(memory_type, memory_id, version)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS memory_versions_owner_idx
    ON memory_versions(memory_type, memory_id, version DESC);

  CREATE TABLE IF NOT EXISTS contradictions (
    contradiction_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    old_claim_id TEXT NOT NULL,
    old_claim_version INTEGER NOT NULL,
    new_claim_id TEXT NOT NULL,
    new_claim_version INTEGER NOT NULL,
    preferred_claim_id TEXT,
    preferred_claim_version INTEGER,
    status TEXT NOT NULL CHECK(status IN ('unresolved', 'resolved', 'temporal', 'coexisting')),
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS contradictions_scope_idx
    ON contradictions(user_id, workspace_id, session_id, status, updated_at);
  CREATE INDEX IF NOT EXISTS contradictions_claim_idx
    ON contradictions(old_claim_id, new_claim_id, status);

  CREATE TABLE IF NOT EXISTS memory_temperatures (
    memory_type TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    tier TEXT NOT NULL CHECK(tier IN ('hot', 'warm', 'cold', 'archive')),
    score REAL NOT NULL,
    access_count INTEGER NOT NULL,
    retrieval_count INTEGER NOT NULL,
    mention_count INTEGER NOT NULL,
    last_accessed_at TEXT,
    last_mentioned_at TEXT,
    explicit_remember INTEGER NOT NULL CHECK(explicit_remember IN (0, 1)),
    active_project INTEGER NOT NULL CHECK(active_project IN (0, 1)),
    pinned INTEGER NOT NULL CHECK(pinned IN (0, 1)),
    updated_at TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    PRIMARY KEY(memory_type, memory_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS memory_temperatures_scope_idx
    ON memory_temperatures(user_id, workspace_id, session_id, tier, score DESC, updated_at);

  CREATE TABLE IF NOT EXISTS retrieval_traces (
    retrieval_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    turn_id TEXT NOT NULL REFERENCES turns(turn_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    evidence_coverage REAL NOT NULL,
    should_abstain INTEGER NOT NULL CHECK(should_abstain IN (0, 1)),
    created_at TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS retrieval_traces_turn_idx
    ON retrieval_traces(turn_id, created_at, retrieval_id);
  CREATE INDEX IF NOT EXISTS retrieval_traces_scope_idx
    ON retrieval_traces(user_id, workspace_id, session_id, created_at DESC, retrieval_id);

  CREATE TABLE IF NOT EXISTS maintenance_jobs (
    job_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    dry_run INTEGER NOT NULL CHECK(dry_run IN (0, 1)),
    attempts INTEGER NOT NULL,
    cursor TEXT,
    available_at TEXT NOT NULL,
    leased_at TEXT,
    completed_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS maintenance_jobs_queue_idx
    ON maintenance_jobs(status, available_at, revision);
  CREATE INDEX IF NOT EXISTS maintenance_jobs_scope_idx
    ON maintenance_jobs(user_id, workspace_id, session_id, status, updated_at);

  CREATE TABLE IF NOT EXISTS maintenance_actions (
    action_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    job_id TEXT NOT NULL REFERENCES maintenance_jobs(job_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    action_type TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('planned', 'applied', 'rolled_back', 'failed')),
    reversible INTEGER NOT NULL CHECK(reversible IN (0, 1)),
    created_at TEXT NOT NULL,
    applied_at TEXT,
    rolled_back_at TEXT,
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    UNIQUE(job_id, sequence)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS maintenance_actions_target_idx
    ON maintenance_actions(target_type, target_id, status, created_at);

  CREATE TABLE IF NOT EXISTS memory_audit_log (
    audit_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    job_id TEXT,
    action_id TEXT,
    event TEXT NOT NULL,
    created_at TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS memory_audit_scope_idx
    ON memory_audit_log(user_id, workspace_id, session_id, created_at, audit_id);

  CREATE TABLE IF NOT EXISTS memory_quality_metrics (
    metric_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    measured_at TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    record_hash TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS memory_quality_owner_idx
    ON memory_quality_metrics(owner_type, owner_id, measured_at DESC);
  CREATE INDEX IF NOT EXISTS memory_quality_scope_idx
    ON memory_quality_metrics(user_id, workspace_id, session_id, measured_at DESC);
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
