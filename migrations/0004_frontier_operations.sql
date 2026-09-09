-- Up Migration

-- The frontier table shipped with the M2 target schema but was never used: the crawl
-- frontier lived on one worker's local disk. M4 makes it the durable frontier of record,
-- which needs a state vocabulary, a failure reason, and indexes for the three access
-- patterns: claiming work for a job, recovering claims whose visibility timeout expired,
-- and releasing the claims of one worker during graceful shutdown.

ALTER TABLE frontier
  ADD COLUMN last_error text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

UPDATE frontier SET state = 'pending' WHERE state NOT IN ('pending', 'claimed', 'handled', 'failed');

ALTER TABLE frontier
  ADD CONSTRAINT frontier_state_allowed
  CHECK (state IN ('pending', 'claimed', 'handled', 'failed'));

-- A claim must record who holds it and since when, so an abandoned claim is recoverable.
ALTER TABLE frontier
  ADD CONSTRAINT frontier_claim_complete
  CHECK (
    (state = 'claimed' AND claimed_by IS NOT NULL AND claimed_at IS NOT NULL)
    OR (state <> 'claimed' AND claimed_by IS NULL AND claimed_at IS NULL)
  );

CREATE INDEX frontier_job_claimable
  ON frontier (job_id, state, scheduled_for, priority DESC);

CREATE INDEX frontier_claim_recovery
  ON frontier (claimed_at)
  WHERE state = 'claimed';

CREATE INDEX frontier_claim_owner
  ON frontier (claimed_by)
  WHERE state = 'claimed';

-- Down Migration

DROP INDEX frontier_claim_owner;
DROP INDEX frontier_claim_recovery;
DROP INDEX frontier_job_claimable;
ALTER TABLE frontier DROP CONSTRAINT frontier_claim_complete;
ALTER TABLE frontier DROP CONSTRAINT frontier_state_allowed;
ALTER TABLE frontier
  DROP COLUMN updated_at,
  DROP COLUMN last_error;
