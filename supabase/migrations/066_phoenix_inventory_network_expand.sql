-- ============================================================================
-- INVENTORY-NETWORK-EXPAND-066-A
--
-- MANUAL APPLY ONLY. DO NOT use supabase db push or any automated runner.
--
-- STRATEGY: Expand -> Frontend Migration -> Contract. This is the EXPAND step.
--
-- It is ADDITIVE AND BACKWARD-COMPATIBLE BY CONSTRUCTION. It adds the network
-- model, roles, assignments, supply routing and availability states that the new
-- frontend needs, while every existing screen keeps working exactly as today.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DELIBERATELY DOES **NOT** DO
-- ─────────────────────────────────────────────────────────────────────────────
--   * No REVOKE of any kind. phoenix_upsert_availability, clear_port_availability
--     and phoenix_clean_availability_data stay callable exactly as today — five
--     production screens still depend on them.
--   * No CHECK forbidding source_kind = 'manual'.
--   * No change to the source_kind default (stays 'manual').
--   * No DROP or RENAME of anything the frontend uses.
--   * No removal of existing point_type or role values.
--   * No RBAC enforcement. No RLS or policy change. No data conversion.
--
-- All of the above belongs to the CONTRACT migration, which must be authored
-- only after the frontend has stopped using the manual path and is deployed.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NETWORK MODEL (three levels)
-- ─────────────────────────────────────────────────────────────────────────────
--   1. Central pharmacy-department warehouses  (warehouses.warehouse_kind='central')
--   2. Health-institution warehouses           (warehouses.warehouse_kind='institution')
--   3. Outlets                                 (distribution_points, exactly three types:
--                                               pharmacy | crash_cabinet | rescue_cart)
--
-- OWNERSHIP is distinct from SUPPLY:
--   ownership : organization -> warehouse -> outlet   (existing FKs)
--   supply    : central -> institution warehouse -> outlet
--
-- Supply is modelled as its own table (warehouse_supply_routes) rather than a
-- single parent_warehouse_id, because an institution may later be supplied by a
-- primary AND a fallback central warehouse. A scalar parent cannot express that.
--
-- SOURCE OF TRUTH (unchanged from 065, restated for the record):
--   warehouse_stock            = current operational truth
--                                (available_quantity is GENERATED STORED)
--   warehouse_stock_movements  = audit trail
--   item_availability          = read projection, scoped per outlet. No global sum.
-- ============================================================================

begin;

-- ============================================================================
-- 0. PRECONDITIONS
-- ============================================================================
DO $guard$
BEGIN
  IF to_regclass('public.warehouses') IS NULL
     OR to_regclass('public.distribution_points') IS NULL
     OR to_regclass('public.profile_scope_assignments') IS NULL
     OR to_regclass('public.permission_keys') IS NULL
     OR to_regclass('public.role_permission_defaults') IS NULL THEN
    RAISE EXCEPTION 'ABORT 066: expected 060/062 schema is absent. Apply earlier migrations first.';
  END IF;

  IF to_regprocedure('public.phoenix_receive_warehouse_stock(uuid,uuid,text,integer,boolean,boolean,uuid,text,text,text,text,text,text,date,numeric,text,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'ABORT 066: migration 065 stock RPCs are absent. Apply 065 first.';
  END IF;

  RAISE NOTICE '066 preconditions OK.';
END;
$guard$;

-- ============================================================================
-- 1. Warehouse kind: central vs institution
--
-- Default 'institution' so every existing warehouse keeps its present meaning
-- without a data decision. Central warehouses are designated explicitly later.
-- ============================================================================
ALTER TABLE public.warehouses
  ADD COLUMN IF NOT EXISTS warehouse_kind text NOT NULL DEFAULT 'institution';

ALTER TABLE public.warehouses
  DROP CONSTRAINT IF EXISTS warehouses_warehouse_kind_chk;

ALTER TABLE public.warehouses
  ADD CONSTRAINT warehouses_warehouse_kind_chk
  CHECK (warehouse_kind IN ('central', 'institution'));

COMMENT ON COLUMN public.warehouses.warehouse_kind IS
  'INVENTORY-NETWORK-EXPAND-066-A: ''central'' = pharmacy-department central warehouse (level 1); ''institution'' = health-institution warehouse (level 2). Defaults to ''institution'' so existing rows keep their current meaning.';

-- ============================================================================
-- 2. Outlet types
--
-- ADDITIVE: the three approved types are added to the existing CHECK. The legacy
-- values (dispensing/storage/returns/emergency) are RETAINED — removing them now
-- would break existing rows and screens. Retiring them belongs to the contract
-- step, after the frontend migrates and any existing rows are reclassified.
-- ============================================================================
ALTER TABLE public.distribution_points
  DROP CONSTRAINT IF EXISTS distribution_points_point_type_check;

ALTER TABLE public.distribution_points
  ADD CONSTRAINT distribution_points_point_type_check
  CHECK (point_type IN (
    -- approved network outlet types (066)
    'pharmacy', 'crash_cabinet', 'rescue_cart',
    -- legacy values retained for backward compatibility; retired in the contract step
    'dispensing', 'storage', 'returns', 'emergency'
  ));

COMMENT ON COLUMN public.distribution_points.point_type IS
  'INVENTORY-NETWORK-EXPAND-066-A: approved outlet types are pharmacy | crash_cabinet | rescue_cart. Legacy values (dispensing/storage/returns/emergency) remain accepted only until the frontend migrates and existing rows are reclassified.';

-- ============================================================================
-- 3. Roles: central_warehouse_manager and outlet_officer
--
-- ADDITIVE: appended to the existing role CHECK. No existing role is removed.
-- ============================================================================
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN (
    'super_admin',
    'central_warehouse_manager',   -- 066: owns one or more central warehouses
    'institution_admin',
    'warehouse_officer',           -- institution warehouse officer
    'outlet_officer',              -- 066: owns one or more outlets
    'port_officer',
    'monthly_status_officer',
    'viewer',
    -- legacy roles retained
    'hospital_admin',
    'warehouse_manager',
    'point_operator',
    'transfer_manager'
  ));

-- ============================================================================
-- 4. Supply routing (distinct from ownership)
--
-- central warehouse --supplies--> institution warehouse
-- `priority` allows a primary route plus fallbacks. A scalar parent_warehouse_id
-- could not express that, which is why this is a table.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.warehouse_supply_routes (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_warehouse_id       uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE RESTRICT,
  target_warehouse_id       uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE RESTRICT,
  priority                  integer NOT NULL DEFAULT 1,
  is_active                 boolean NOT NULL DEFAULT true,
  notes                     text,
  created_by                uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warehouse_supply_routes_no_self_supply CHECK (source_warehouse_id <> target_warehouse_id),
  CONSTRAINT warehouse_supply_routes_priority_positive CHECK (priority >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS warehouse_supply_routes_active_pair_uniq
  ON public.warehouse_supply_routes (source_warehouse_id, target_warehouse_id)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS warehouse_supply_routes_target_idx
  ON public.warehouse_supply_routes (target_warehouse_id) WHERE is_active;

COMMENT ON TABLE public.warehouse_supply_routes IS
  'INVENTORY-NETWORK-EXPAND-066-A: supply relationships, deliberately separate from organizational ownership. source (central) supplies target (institution warehouse). priority 1 = primary; higher = fallback.';

ALTER TABLE public.warehouse_supply_routes ENABLE ROW LEVEL SECURITY;

-- Read-only to signed-in users; writes go through server-side paths only, never
-- direct client DML. anon gets nothing.
GRANT SELECT ON TABLE public.warehouse_supply_routes TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.warehouse_supply_routes FROM authenticated;
REVOKE ALL ON TABLE public.warehouse_supply_routes FROM anon;

DROP POLICY IF EXISTS warehouse_supply_routes_select_scoped ON public.warehouse_supply_routes;
CREATE POLICY warehouse_supply_routes_select_scoped
  ON public.warehouse_supply_routes
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.warehouses w
      WHERE w.id IN (source_warehouse_id, target_warehouse_id)
        AND w.organization_id = public.phoenix_my_org()
    )
    OR public.phoenix_my_role() = 'super_admin'
  );

-- ============================================================================
-- 5. Outlet scope for assignments
--
-- ADDITIVE: 'outlet' is added alongside the existing scope types. The existing
-- 'distribution_point' value is retained so 062-era assignments keep working.
-- ============================================================================
ALTER TABLE public.profile_scope_assignments
  DROP CONSTRAINT IF EXISTS profile_scope_assignments_scope_type_check;

ALTER TABLE public.profile_scope_assignments
  ADD CONSTRAINT profile_scope_assignments_scope_type_check
  CHECK (scope_type IN ('warehouse', 'distribution_point', 'outlet'));

-- ============================================================================
-- 6. Availability states: unknown vs missing vs not_stocked
--
-- ADDITIVE: appended to the existing CHECK. Nothing is removed, so QR and the
-- reports keep rendering every value they already know.
--
-- Semantics (the distinction the model previously could not express):
--   'unknown'     : onboarding incomplete, or no evidence the item is inventory-tracked
--                   at this outlet. NOT zero. The UI must not render it as 0.
--   'not_stocked' : the item is deliberately not carried at this outlet.
--   'missing'     : item AND outlet are in inventory scope and usable quantity is 0.
-- ============================================================================
ALTER TABLE public.item_availability
  DROP CONSTRAINT IF EXISTS item_availability_condition_check;

ALTER TABLE public.item_availability
  ADD CONSTRAINT item_availability_condition_check
  CHECK (condition IN (
    'available', 'low_stock', 'missing', 'surplus', 'near_expiry', 'expired',
    -- 066 additions
    'unknown', 'not_stocked'
  ));

COMMENT ON COLUMN public.item_availability.condition IS
  'INVENTORY-NETWORK-EXPAND-066-A: ''unknown'' = untracked/onboarding incomplete (NOT zero); ''not_stocked'' = deliberately not carried at this outlet; ''missing'' = in scope and usable quantity is 0.';

-- ============================================================================
-- 7. Permission keys for the new operations
--
-- Outlet management is its own key. warehouses.manage is deliberately NOT reused
-- as a blanket inventory permission — warehouse_officer must keep
-- warehouses.view = true and warehouses.manage = false.
-- ============================================================================
INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous) VALUES
  ('outlets.view',                'outlets',        'view',        'View outlets',                    'عرض المنافذ',                 false),
  ('outlets.manage',              'outlets',        'manage',      'Create and manage outlets',       'إنشاء وإدارة المنافذ',         false),
  ('outlets.assign_officer',      'outlets',        'assign',      'Assign outlet officers',          'تعيين مسؤولي المنافذ',         false),
  ('outlet_stock.view',           'outlet_stock',   'view',        'View outlet stock',               'عرض مخزون المنفذ',            false),
  ('outlet_stock.receive',        'outlet_stock',   'receive',     'Receive stock at an outlet',      'استلام مخزون في المنفذ',      false),
  ('outlet_stock.dispense',       'outlet_stock',   'dispense',    'Record dispensing/consumption',   'تسجيل الصرف والاستهلاك',      false),
  ('outlet_stock.return',         'outlet_stock',   'return',      'Record outlet returns',           'تسجيل مرتجعات المنفذ',        false),
  ('outlet_stock.count',          'outlet_stock',   'count',       'Physical count at an outlet',     'الجرد في المنفذ',             true),
  ('central_warehouse.view',      'central_warehouse', 'view',     'View central warehouses',         'عرض المخازن المركزية',        false),
  ('central_warehouse.manage',    'central_warehouse', 'manage',   'Manage central warehouses',       'إدارة المخازن المركزية',      true),
  ('central_warehouse.receive',   'central_warehouse', 'receive',  'Receive from supplier',           'الاستلام من المورد',          false),
  ('central_warehouse.fulfil',    'central_warehouse', 'fulfil',   'Fulfil institution requests',     'تجهيز طلبات المؤسسات',        false),
  ('supply_routes.view',          'supply_routes',  'view',        'View supply routes',              'عرض مسارات التجهيز',          false),
  ('supply_routes.manage',        'supply_routes',  'manage',      'Manage supply routes',            'إدارة مسارات التجهيز',        true),
  ('warehouse_stock.transfer',    'warehouse_stock','transfer',    'Transfer stock between locations','تحويل المخزون بين المواقع',   false)
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- 8. Role defaults for the new roles and keys (Shadow Mode data only)
--
-- RBAC enforcement stays OFF. These rows describe intent so shadow telemetry can
-- compare decisions; they grant nothing by themselves.
-- ============================================================================

-- super_admin: everything the new keys cover.
INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
SELECT 'super_admin', k.key, true
FROM public.permission_keys k
WHERE k.key IN ('outlets.view','outlets.manage','outlets.assign_officer','outlet_stock.view',
                'outlet_stock.receive','outlet_stock.dispense','outlet_stock.return','outlet_stock.count',
                'central_warehouse.view','central_warehouse.manage','central_warehouse.receive',
                'central_warehouse.fulfil','supply_routes.view','supply_routes.manage',
                'warehouse_stock.transfer')
ON CONFLICT (role, permission_key) DO NOTHING;

-- central_warehouse_manager: full control INSIDE its assigned central warehouses.
-- No outlet management, no platform settings.
INSERT INTO public.role_permission_defaults (role, permission_key, allowed) VALUES
  ('central_warehouse_manager', 'central_warehouse.view',           true),
  ('central_warehouse_manager', 'central_warehouse.manage',         true),
  ('central_warehouse_manager', 'central_warehouse.receive',        true),
  ('central_warehouse_manager', 'central_warehouse.fulfil',         true),
  ('central_warehouse_manager', 'warehouse_stock.view',             true),
  ('central_warehouse_manager', 'warehouse_stock.movements_view',   true),
  ('central_warehouse_manager', 'warehouse_stock.adjust',           true),
  ('central_warehouse_manager', 'warehouse_stock.correct',          true),
  ('central_warehouse_manager', 'warehouse_stock.transfer',         true),
  ('central_warehouse_manager', 'warehouse_dispatch.view',          true),
  ('central_warehouse_manager', 'warehouse_dispatch.create',        true),
  ('central_warehouse_manager', 'warehouse_dispatch.send',          true),
  ('central_warehouse_manager', 'warehouse_dispatch.audit',         true),
  ('central_warehouse_manager', 'supply_routes.view',               true),
  ('central_warehouse_manager', 'warehouses.view',                  true),
  ('central_warehouse_manager', 'warehouses.manage',                false),
  ('central_warehouse_manager', 'outlets.manage',                   false),
  ('central_warehouse_manager', 'supply_routes.manage',             false),
  ('central_warehouse_manager', 'users.create',                     false),
  ('central_warehouse_manager', 'users.assign_role',                false)
ON CONFLICT (role, permission_key) DO NOTHING;

-- warehouse_officer: institution warehouse + owns its outlets.
-- warehouses.view stays true and warehouses.manage stays false (unchanged).
INSERT INTO public.role_permission_defaults (role, permission_key, allowed) VALUES
  ('warehouse_officer', 'outlets.view',            true),
  ('warehouse_officer', 'outlets.manage',          true),
  ('warehouse_officer', 'outlets.assign_officer',  true),
  ('warehouse_officer', 'outlet_stock.view',       true),
  ('warehouse_officer', 'warehouse_stock.transfer',true),
  ('warehouse_officer', 'supply_routes.view',      true),
  ('warehouse_officer', 'central_warehouse.view',  false),
  ('warehouse_officer', 'central_warehouse.manage',false),
  ('warehouse_officer', 'supply_routes.manage',    false)
ON CONFLICT (role, permission_key) DO NOTHING;

-- outlet_officer: its assigned outlets only. Cannot see warehouse or central stock.
INSERT INTO public.role_permission_defaults (role, permission_key, allowed) VALUES
  ('outlet_officer', 'outlets.view',              true),
  ('outlet_officer', 'outlet_stock.view',         true),
  ('outlet_officer', 'outlet_stock.receive',      true),
  ('outlet_officer', 'outlet_stock.dispense',     true),
  ('outlet_officer', 'outlet_stock.return',       true),
  ('outlet_officer', 'outlet_stock.count',        true),
  ('outlet_officer', 'outlets.manage',            false),
  ('outlet_officer', 'outlets.assign_officer',    false),
  ('outlet_officer', 'warehouse_stock.view',      false),
  ('outlet_officer', 'warehouse_stock.adjust',    false),
  ('outlet_officer', 'warehouse_stock.correct',   false),
  ('outlet_officer', 'warehouse_stock.transfer',  false),
  ('outlet_officer', 'warehouses.view',           false),
  ('outlet_officer', 'warehouses.manage',         false),
  ('outlet_officer', 'central_warehouse.view',    false),
  ('outlet_officer', 'central_warehouse.manage',  false),
  ('outlet_officer', 'supply_routes.view',        false),
  ('outlet_officer', 'supply_routes.manage',      false)
ON CONFLICT (role, permission_key) DO NOTHING;

-- Every pre-existing role is explicitly denied the new privileged keys, so a new
-- key can never widen an old role by defaulting to allowed.
INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
SELECT r.role, k.key, false
FROM (VALUES ('institution_admin'),('port_officer'),('monthly_status_officer'),('viewer'),
             ('hospital_admin'),('warehouse_manager'),('point_operator'),('transfer_manager')) AS r(role)
CROSS JOIN (VALUES ('central_warehouse.manage'),('central_warehouse.receive'),('central_warehouse.fulfil'),
                   ('supply_routes.manage'),('outlets.manage'),('outlets.assign_officer'),
                   ('outlet_stock.count'),('warehouse_stock.transfer')) AS k(key)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ============================================================================
-- 9. POST-CONDITIONS — additive and non-breaking, proven not asserted
-- ============================================================================
DO $verify$
BEGIN
  -- 9a. The manual path MUST still work. This migration is worthless if it
  --     silently breaks the five production screens it exists to protect.
  IF NOT has_function_privilege('authenticated',
      'public.phoenix_upsert_availability(uuid,text,text,text,text,integer,text,date,text,text,text,numeric,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABORT 066: phoenix_upsert_availability lost authenticated EXECUTE. The expand step must not break the current frontend.';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.clear_port_availability(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABORT 066: clear_port_availability lost authenticated EXECUTE.';
  END IF;

  -- 9b. source_kind must be untouched: still defaulting to 'manual', still allowing it.
  IF EXISTS (
    SELECT 1 FROM pg_attrdef d
    JOIN pg_class c ON c.oid = d.adrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.adnum
    WHERE n.nspname='public' AND c.relname='item_availability' AND a.attname='source_kind'
      AND pg_get_expr(d.adbin, d.adrelid) NOT ILIKE '%manual%'
  ) THEN
    RAISE EXCEPTION 'ABORT 066: source_kind default changed. That belongs to the contract step, not expand.';
  END IF;

  -- 9c. New objects exist.
  IF to_regclass('public.warehouse_supply_routes') IS NULL THEN
    RAISE EXCEPTION 'ABORT 066: warehouse_supply_routes was not created.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
                 JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.relname='warehouses' AND a.attname='warehouse_kind') THEN
    RAISE EXCEPTION 'ABORT 066: warehouses.warehouse_kind was not added.';
  END IF;

  -- 9d. The three approved outlet types are accepted.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='distribution_points'
      AND con.conname='distribution_points_point_type_check'
      AND pg_get_constraintdef(con.oid) LIKE '%crash_cabinet%'
      AND pg_get_constraintdef(con.oid) LIKE '%rescue_cart%'
      AND pg_get_constraintdef(con.oid) LIKE '%pharmacy%'
  ) THEN
    RAISE EXCEPTION 'ABORT 066: approved outlet types were not added.';
  END IF;

  -- 9e. New roles are accepted; legacy roles survive.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='profiles' AND con.conname='profiles_role_check'
      AND pg_get_constraintdef(con.oid) LIKE '%central_warehouse_manager%'
      AND pg_get_constraintdef(con.oid) LIKE '%outlet_officer%'
      AND pg_get_constraintdef(con.oid) LIKE '%transfer_manager%'
  ) THEN
    RAISE EXCEPTION 'ABORT 066: role CHECK is missing a new role or dropped a legacy one.';
  END IF;

  -- 9f. unknown / not_stocked are accepted; every legacy condition survives.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='item_availability'
      AND con.conname='item_availability_condition_check'
      AND pg_get_constraintdef(con.oid) LIKE '%unknown%'
      AND pg_get_constraintdef(con.oid) LIKE '%not_stocked%'
      AND pg_get_constraintdef(con.oid) LIKE '%near_expiry%'
      AND pg_get_constraintdef(con.oid) LIKE '%surplus%'
  ) THEN
    RAISE EXCEPTION 'ABORT 066: condition CHECK is missing a new state or dropped a legacy one.';
  END IF;

  -- 9g. warehouse_officer keeps the required boundary.
  IF (SELECT allowed FROM public.role_permission_defaults
      WHERE role='warehouse_officer' AND permission_key='warehouses.view') IS DISTINCT FROM true
     OR (SELECT allowed FROM public.role_permission_defaults
      WHERE role='warehouse_officer' AND permission_key='warehouses.manage') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ABORT 066: warehouse_officer must keep warehouses.view=true and warehouses.manage=false.';
  END IF;

  -- 9h. outlet_officer must not see warehouse stock.
  IF (SELECT allowed FROM public.role_permission_defaults
      WHERE role='outlet_officer' AND permission_key='warehouse_stock.view') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ABORT 066: outlet_officer must not have warehouse_stock.view.';
  END IF;

  -- 9i. anon gained nothing.
  IF has_table_privilege('anon', 'public.warehouse_supply_routes', 'SELECT')
     OR has_table_privilege('anon', 'public.warehouse_supply_routes', 'INSERT') THEN
    RAISE EXCEPTION 'ABORT 066: anon gained access to supply routes.';
  END IF;

  RAISE NOTICE '066 verified: additive network foundation in place; the existing manual path still works.';
END;
$verify$;

commit;
