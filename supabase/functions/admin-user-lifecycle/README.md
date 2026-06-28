# Edge Function — `admin-user-lifecycle`

Secure server-side user disable / enable / hard-delete for MediStock Phoenix V2.
`service_role` lives only in the Deno runtime — never in the frontend bundle.

## Status

**Scaffold — not deployed.** Requires migration `011_phoenix_user_lifecycle_controls.sql`
to be applied before the delete/disable feature is considered live.

## Deploy (manual, when ready)

```bash
# SUPABASE_SERVICE_ROLE_KEY was already set during admin-create-user deploy.
supabase functions deploy admin-user-lifecycle --project-ref <your-project-ref>
supabase secrets list --project-ref <your-project-ref>   # confirm key present
```

## Authorization contract

| Action | Caller requirement | Notes |
|--------|-------------------|-------|
| `disable` | `super_admin` | Bans auth user (prevents login) + sets profile `status = 'suspended'` |
| `enable`  | `super_admin` | Removes ban + sets profile `status = 'active'` |
| `delete`  | `super_admin` | Hard deletes auth user; profile cascades via FK. Requires confirmation string. |

Rules that always apply:
- Cannot act on self (`SELF_ACTION_FORBIDDEN`).
- Cannot delete the last active `super_admin` (`LAST_SUPER_ADMIN`).
- Hard delete requires `confirmation = "DELETE_USER_<email>"`.

## Request / response

```
POST /functions/v1/admin-user-lifecycle
Authorization: Bearer <caller-jwt>
{ "action": "disable", "target_user_id": "<uuid>" }
{ "action": "enable",  "target_user_id": "<uuid>" }
{ "action": "delete",  "target_user_id": "<uuid>", "confirmation": "DELETE_USER_user@example.com" }

→ { "ok": true,  "action": "disabled"|"enabled"|"deleted", "user_id": "<uuid>" }
→ { "ok": false, "error": "SELF_ACTION_FORBIDDEN"|"LAST_SUPER_ADMIN"|"INVALID_CONFIRMATION"|... }
```

## Safety notes

- `service_role` read only from `Deno.env` — never returned in a response.
- Auth ban (`ban_duration: '876000h'`) is server-enforced; the user cannot bypass it.
- `profiles.disabled_at` / `disabled_by` columns are set if migration 011 is applied;
  the function degrades gracefully if they are absent.
- Profile cascade-deletion from `auth.users` is defined in migration 001 (`ON DELETE CASCADE`).

## Smoke tests after deployment

```bash
BASE="https://<project-ref>.supabase.co/functions/v1/admin-user-lifecycle"
TOKEN="<super_admin-jwt>"

# 1. No auth → 401
curl -s -X POST "$BASE" -H "Content-Type: application/json" -d '{}' | jq .

# 2. Invalid action → 400 INVALID_ACTION
curl -s -X POST "$BASE" -H "Authorization: Bearer $TOKEN" \
  -d '{"action":"nuke","target_user_id":"..."}' | jq .

# 3. Self-disable → 403 SELF_ACTION_FORBIDDEN
curl -s -X POST "$BASE" -H "Authorization: Bearer $TOKEN" \
  -d "{\"action\":\"disable\",\"target_user_id\":\"<your-own-id>\"}" | jq .

# 4. Delete last super_admin → 403 LAST_SUPER_ADMIN
# (only if target is the only super_admin)

# 5. Delete without correct confirmation → 400 INVALID_CONFIRMATION
curl -s -X POST "$BASE" -H "Authorization: Bearer $TOKEN" \
  -d '{"action":"delete","target_user_id":"<uuid>","confirmation":"wrong"}' | jq .

# 6. Disable smoke-test user (super_admin caller, valid target)
curl -s -X POST "$BASE" -H "Authorization: Bearer $TOKEN" \
  -d '{"action":"disable","target_user_id":"<smoke-user-uuid>"}' | jq .
# Expected: {"ok":true,"action":"disabled","user_id":"<uuid>"}
```
