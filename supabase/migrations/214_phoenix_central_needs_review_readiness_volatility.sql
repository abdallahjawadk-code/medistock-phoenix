-- M214 — Central Needs readiness RPC transaction-mode correction.
--
-- Production defect:
--   phoenix_central_needs_review_readiness(uuid) was declared STABLE in M211,
--   while its canonical authorization guard takes SELECT ... FOR KEY SHARE.
--   PostgREST therefore executed the RPC in a read-only transaction and
--   PostgreSQL raised SQLSTATE 25006 before readiness could be returned.
--
-- Scope is intentionally surgical: preserve the function body, SECURITY
-- DEFINER posture, search_path, grants, authorization guard and blocker logic;
-- change only the volatility classification so POST /rpc executes read-write.

ALTER FUNCTION public.phoenix_central_needs_review_readiness(uuid) VOLATILE;
