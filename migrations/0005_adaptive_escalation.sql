-- Up Migration

-- `browser=auto` resolved to the HTTP crawler and never rendered, so a JavaScript-built
-- page completed with empty extraction. M5 lets a job escalate to the browser worker,
-- which needs two things recorded: which fetcher produced each result, and which frontier
-- rows still owe a rendered fetch.

ALTER TABLE results
  ADD COLUMN fetcher text NOT NULL DEFAULT 'http';

ALTER TABLE results
  ADD CONSTRAINT results_fetcher_allowed CHECK (fetcher IN ('http', 'browser'));

-- 'any' is fetchable by whichever worker holds the job; 'browser' was judged
-- render-dependent and must be refetched by a rendered browser before it counts.
ALTER TABLE frontier
  ADD COLUMN fetcher text NOT NULL DEFAULT 'any';

ALTER TABLE frontier
  ADD CONSTRAINT frontier_fetcher_allowed CHECK (fetcher IN ('any', 'browser'));

CREATE INDEX frontier_escalated
  ON frontier (job_id)
  WHERE fetcher = 'browser';

-- Down Migration

DROP INDEX frontier_escalated;
ALTER TABLE frontier DROP CONSTRAINT frontier_fetcher_allowed;
ALTER TABLE frontier DROP COLUMN fetcher;
ALTER TABLE results DROP CONSTRAINT results_fetcher_allowed;
ALTER TABLE results DROP COLUMN fetcher;
