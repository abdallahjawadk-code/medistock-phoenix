-- ============================================================================
-- MONTHLY-STATUS-PUBLIC-EXECUTE-LOCKDOWN-121
--
-- 113 (phoenix_monthly_status_direct_write_lockdown) intended to close two
-- boundaries for the monthly-status/stocktake surface: table-level direct
-- writes, and PUBLIC/anon EXECUTE on the eleven status/threshold RPCs. Its own
-- precondition guard used "does `authenticated` still hold INSERT on
-- inventory_status_report_lines" as a proxy for "has 113 already applied
-- somewhere". That proxy was already false the FIRST time 113 could run,
-- because inventory_status_report_lines (created fresh by 092, in this same
-- pending batch) never held INSERT for authenticated in the first place — it
-- inherited SELECT-only from a default-privileges rule already in effect
-- before 092 ran. 113 therefore refused to apply, and its real, substantive
-- purpose — closing PUBLIC/anon EXECUTE on the eleven functions below — was
-- never carried out. This migration closes exactly that remaining gap.
--
-- 113 is NOT edited (001–120 are immutable). This migration is additive-only:
-- eleven idempotent REVOKE EXECUTE statements, nothing else. No table DDL, no
-- data changes, no GRANT (authenticated/service_role already hold EXECUTE on
-- all eleven, verified live before writing this file — see the migration
-- PR/evidence trail). REVOKE of a privilege a role does not hold is a
-- harmless no-op in PostgreSQL, so this file is safe to run more than once.
--
-- Verified before writing this file: migrations 114–120 do not reference any
-- of these eleven functions (no redefinition, no re-grant), so nothing
-- downstream could have re-opened PUBLIC/anon EXECUTE after 113's original
-- authors intended it closed.
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.phoenix_status_center_authorized(uuid, text)
  FROM PUBLIC, anon;

REVOKE EXECUTE ON FUNCTION public.phoenix_set_inventory_threshold_planning(uuid, integer, integer)
  FROM PUBLIC, anon;

REVOKE EXECUTE ON FUNCTION public.phoenix_status_record_stocktake(uuid, text, uuid, text, jsonb)
  FROM PUBLIC, anon;

REVOKE EXECUTE ON FUNCTION public.phoenix_status_prepare_report(uuid)
  FROM PUBLIC, anon;

REVOKE EXECUTE ON FUNCTION public.phoenix_status_classify_lines(uuid, jsonb)
  FROM PUBLIC, anon;

REVOKE EXECUTE ON FUNCTION public.phoenix_status_confirm_missing(uuid)
  FROM PUBLIC, anon;

REVOKE EXECUTE ON FUNCTION public.phoenix_status_submit_report(uuid)
  FROM PUBLIC, anon;

REVOKE EXECUTE ON FUNCTION public.phoenix_status_return_for_clarification(uuid, text)
  FROM PUBLIC, anon;

REVOKE EXECUTE ON FUNCTION public.phoenix_status_approve_lock_report(uuid)
  FROM PUBLIC, anon;

REVOKE EXECUTE ON FUNCTION public.phoenix_status_create_amendment(uuid, text)
  FROM PUBLIC, anon;

REVOKE EXECUTE ON FUNCTION public.phoenix_status_get_outlet_contribution(uuid, uuid)
  FROM PUBLIC, anon;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'phoenix_status_center_authorized', 'phoenix_set_inventory_threshold_planning',
        'phoenix_status_record_stocktake', 'phoenix_status_prepare_report',
        'phoenix_status_classify_lines', 'phoenix_status_confirm_missing',
        'phoenix_status_submit_report', 'phoenix_status_return_for_clarification',
        'phoenix_status_approve_lock_report', 'phoenix_status_create_amendment',
        'phoenix_status_get_outlet_contribution'
      )
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION '121 VERIFY FAILED: anon still holds EXECUTE on a protected monthly-status function';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'phoenix_status_center_authorized', 'phoenix_set_inventory_threshold_planning',
        'phoenix_status_record_stocktake', 'phoenix_status_prepare_report',
        'phoenix_status_classify_lines', 'phoenix_status_confirm_missing',
        'phoenix_status_submit_report', 'phoenix_status_return_for_clarification',
        'phoenix_status_approve_lock_report', 'phoenix_status_create_amendment',
        'phoenix_status_get_outlet_contribution'
      )
      AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION '121 VERIFY FAILED: authenticated lost EXECUTE on a protected monthly-status function';
  END IF;
  RAISE NOTICE 'MONTHLY-STATUS-PUBLIC-EXECUTE-LOCKDOWN-121: verified.';
END;
$verify$;
