-- D3: budgets moved to the engine, where Run Manager checks and reserves them
-- atomically at run start (orchestration_db migration 0041). platform-api now
-- relays /api/v1/budgets to the engine, so this table (0024, B2.9b) is retired.
--
-- Its rows are not carried over: B2.9b budgets were never deployed (no
-- environment beyond developers' machines has run 0024), and their shape
-- (named, per-currency, free-form thresholds) is not the engine's (kind,
-- period, INR, fixed 50/80% alerts, hard or warn), so a copy would have to
-- guess. A workspace recreates its budget in the new shape.
DROP TABLE IF EXISTS "budgets";
