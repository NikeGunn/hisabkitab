-- Rehearsal Lab: where agents are rehearsed on synthetic bookkeeping episodes,
-- judged deterministically, and compared before any change reaches customers.
--
-- ISOLATION (the point of this migration):
--   * Everything lives in its own schema `rehearsal`. No table here references a
--     tenant table, and nothing here holds customer data — scenarios are synthetic.
--   * The lab worker connects as `hisab_lab`, which gets USAGE on `rehearsal` ONLY.
--     It has no grant on any public.* table, so even a compromised lab process
--     cannot read or write a customer ledger (Postgres refuses, not our code).
--   * `events` is APPEND-ONLY for the lab: INSERT + SELECT, never UPDATE/DELETE,
--     and every row carries a hash chain so tampering is detectable.
--   * The admin panel (hisab_orch) may READ the lab and record a human release
--     decision; it cannot rewrite episodes or events.
--
-- Role: created here NOLOGIN when absent so grants apply on an existing database;
-- infra/postgres/init/00-roles.sh creates it WITH a password on a fresh volume, and
-- docs (agents-learning/docs/07-deployment-runbook.md) give the one-time
-- `ALTER ROLE hisab_lab LOGIN PASSWORD …` for an existing one.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hisab_lab') THEN
    CREATE ROLE hisab_lab NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS rehearsal;

-- One evaluation run: an agent version on a frozen scenario set.
CREATE TABLE rehearsal.runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment      TEXT NOT NULL,
  agent           TEXT NOT NULL,
  agent_version   TEXT NOT NULL,
  split           TEXT NOT NULL,
  dataset_version TEXT NOT NULL,
  dataset_hash    TEXT NOT NULL,
  env_version     TEXT NOT NULL,
  judge_version   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  budget_paisa    BIGINT NOT NULL DEFAULT 0 CHECK (budget_paisa >= 0),
  summary         JSONB,          -- pass rate, CI, by-family, failure classes (written on completion)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX runs_created_idx ON rehearsal.runs (created_at DESC);

-- One episode = one scenario for one run. Also the work queue for the durable worker.
CREATE TABLE rehearsal.episodes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            UUID NOT NULL REFERENCES rehearsal.runs(id) ON DELETE CASCADE,
  scenario_id       TEXT NOT NULL,
  family            TEXT NOT NULL,
  split             TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'quarantined')),
  attempt           INT NOT NULL DEFAULT 0,
  -- Lease + fencing token: a worker owns the episode until lease_until; every write
  -- it makes must still match lease_token, so a "zombie" worker whose lease expired
  -- cannot overwrite the new owner's progress.
  lease_owner       TEXT,
  lease_until       TIMESTAMPTZ,
  lease_token       BIGINT NOT NULL DEFAULT 0,
  checkpoint        JSONB,          -- env snapshot + agent memory + step records
  checkpoint_digest TEXT,
  passed            BOOLEAN,
  reward            DOUBLE PRECISION,
  failure_class     TEXT,
  hard              TEXT[] NOT NULL DEFAULT '{}',
  steps             INT,
  input_tokens      BIGINT NOT NULL DEFAULT 0,
  output_tokens     BIGINT NOT NULL DEFAULT 0,
  cost_paisa        BIGINT NOT NULL DEFAULT 0,
  verdict           JSONB,
  langsmith_run_id  TEXT,
  error             TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, scenario_id)
);
CREATE INDEX episodes_claim_idx ON rehearsal.episodes (status, lease_until);
CREATE INDEX episodes_run_idx ON rehearsal.episodes (run_id);

-- The trajectory: append-only, ordered, hash-chained per episode.
CREATE TABLE rehearsal.events (
  episode_id  UUID NOT NULL REFERENCES rehearsal.episodes(id) ON DELETE CASCADE,
  seq         INT NOT NULL CHECK (seq >= 0),
  kind        TEXT NOT NULL,
  data        JSONB NOT NULL,
  attempt     INT NOT NULL DEFAULT 1,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (episode_id, seq)
);

-- Policy-training runs reported by the research layer (agents-learning/research).
CREATE TABLE rehearsal.training_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  algorithm      TEXT NOT NULL,
  reward_version TEXT NOT NULL,
  config         JSONB NOT NULL,
  curve          JSONB NOT NULL,   -- [{iteration, mean_reward, pass_rate, hard_rate, ...}]
  evaluation     JSONB NOT NULL,   -- held-out results
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Human release gate: a person approves or rejects a candidate, with the evidence.
CREATE TABLE rehearsal.release_decisions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate        TEXT NOT NULL,
  baseline_run_id  UUID NOT NULL REFERENCES rehearsal.runs(id),
  candidate_run_id UUID NOT NULL REFERENCES rehearsal.runs(id),
  gate             TEXT NOT NULL CHECK (gate IN ('PASS', 'FAIL', 'BLOCKED')),
  decision         TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason           TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 1000),
  comparison       JSONB NOT NULL,
  decided_by       TEXT NOT NULL,
  decided_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A failing candidate can never be approved, whatever the UI sends.
  CHECK (NOT (decision = 'approved' AND gate <> 'PASS'))
);

-- ---------------------------------------------------------------- least privilege
REVOKE ALL ON SCHEMA rehearsal FROM PUBLIC;
GRANT USAGE ON SCHEMA rehearsal TO hisab_lab, hisab_orch;

GRANT SELECT, INSERT, UPDATE ON rehearsal.runs, rehearsal.episodes TO hisab_lab;
GRANT SELECT, INSERT ON rehearsal.events, rehearsal.training_runs TO hisab_lab;
GRANT SELECT ON rehearsal.release_decisions TO hisab_lab;

GRANT SELECT ON ALL TABLES IN SCHEMA rehearsal TO hisab_orch;
GRANT INSERT ON rehearsal.release_decisions TO hisab_orch;
