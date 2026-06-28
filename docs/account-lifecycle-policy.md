# MediStock-Babil Phoenix V2 — Account Lifecycle Policy

**Policy ID:** ACCOUNT-LIFECYCLE-POLICY-A  
**Status:** Active  
**Scope:** All authenticated user accounts managed within the Phoenix platform.

---

## 1. Official Lifecycle States

A Phoenix user account may exist in one of the following states:

| State | `profiles.status` | Auth banned? | Description |
|---|---|---|---|
| **active** | `active` | No | Normal operating state. User can log in and act within their role. |
| **suspended** | `suspended` | Yes (`ban_duration: 876000h`) | User is disabled. Cannot log in. Profile is preserved. All historical records remain attributed correctly. |
| **corrected** | `active` | No | Conceptual state: the account belongs to the same real person, but their `full_name` or `email` was corrected. Allowed only via a super_admin correction action. No new DB column — tracked by audit log or comment. |
| **recycled_candidate** | `suspended` | Yes | Conceptual state: a suspended account has been identified for future recycling. No new DB column until the recycling workflow is implemented. |
| **recycled** | `active` | No | Conceptual state: a formerly suspended account has been reassigned to a different real person through the dedicated recycling workflow (not yet implemented). Requires identity snapshot before recycling. |

> **Note:** `corrected`, `recycled_candidate`, and `recycled` are conceptual states for policy documentation. They do not yet have separate DB columns. The technical implementation of recycling is deferred to a future phase (USER-IDENTITY-SNAPSHOT-FOUNDATION-A).

---

## 2. Allowed Actions by Role

### super_admin

| Action | Allowed | Notes |
|---|---|---|
| Invite/create any user in any organization | ✅ | Via `admin-create-user` Edge Function |
| Create `institution_admin` | ✅ | Only super_admin may do this |
| Create `super_admin` | ✅ | Only super_admin may do this |
| Disable any user | ✅ | Via `admin-user-lifecycle` Edge Function |
| Enable any user | ✅ | Via `admin-user-lifecycle` Edge Function |
| Correct name/email of existing user | ✅ | For same real person only; must not be used for recycling |
| Trigger password reset | ✅ | Via Supabase Auth email flow; admin never sees the password |
| Hard delete a user | ⚠ Deferred | Not a normal operational action; gated in UI; only for test/cleanup by platform operator |
| Recycle a suspended account | ✅ | Via `admin-recycle-user` Edge Function; target must be suspended; requires `users.recycle` permission |
| Assign/modify permissions | ✅ | Via permission matrix UI |

### institution_admin

| Action | Allowed | Notes |
|---|---|---|
| Invite/create users in own organization | ✅ | Via `admin-create-user`; own org only; cannot create super_admin or institution_admin |
| Assign roles (`warehouse_officer`, `port_officer`, `monthly_status_officer`, `viewer`) | ✅ | Own org only |
| Disable/enable users in own organization | ✅ Only with `users.disable` | Not granted by default; super_admin must explicitly grant `users.disable`. Cannot disable super_admin or institution_admin. |
| Act on users outside own organization | ❌ | `CROSS_ORG_FORBIDDEN` |
| Hard delete | ❌ | Blocked at Edge Function level |
| Recycle accounts in own org | ⚠ Only with `users.recycle` | Not granted by default; super_admin must explicitly grant `users.recycle`. Cannot recycle super_admin or institution_admin. Target must be suspended. |
| Correct name/email | ❌ | Must be done by super_admin |

### warehouse_officer / port_officer / monthly_status_officer / viewer

| Action | Allowed |
|---|---|
| Any user management action | ❌ |
| Any lifecycle action | ❌ |

These roles hold no `users.*` permissions by default and have no access to the user management screen.

---

## 3. Definitions

### 3.1 Disable

Disable is the **preferred action** when a user leaves the organization or their access must be revoked immediately.

**What happens:**
1. The Supabase auth user is banned (`ban_duration: 876000h` ≈ 100 years) — the user cannot log in.
2. `profiles.status` is set to `suspended`.
3. If migration 011 is applied: `profiles.disabled_at` and `profiles.disabled_by` are set for audit.

**What is preserved:**
- The profile row and its `id` remain in the database.
- All historical records (status reports, QR actions, audit logs) that reference this profile's `id` remain correctly attributed.
- The account can be re-enabled at any time.

**What disable is NOT:**
- Disable is not recycling. The account still belongs to the original person.
- Disable is not deletion. The auth user and profile both persist.

### 3.2 Correction (Name / Email Fix)

Correction is allowed **only when the same real person's details need fixing** (e.g. a typo in `full_name`, or a change in their institutional email address that represents the same individual).

**Rules:**
- Only super_admin may perform corrections.
- Correction must never be used to transfer an account from one real person to another — that is recycling, not correction.
- If the corrected field is `email`, the Supabase Auth email must also be updated to match (via the admin console or an Edge Function — not yet automated in UI).

**Why this matters:**  
Retroactive name/email changes affect how all past operations appear in the UI. Correction of a genuine typo is acceptable. Reassigning an account is not.

### 3.3 Password Reset

Users reset their own passwords through the standard Supabase Auth email flow:

1. User (or admin on their behalf) calls `requestPasswordReset(email)`.
2. Supabase sends a reset link to the user's email.
3. The user follows the link, which opens the app at `/auth/callback` with a recovery session.
4. The user calls `updatePassword(newPassword)`.

**Rules:**
- Admins never see or set user passwords directly.
- The temporary password mode (available during user creation via the Advanced option) is a one-time setup convenience. The user is expected to reset their password afterward via the normal flow.
- `SUPABASE_SERVICE_ROLE_KEY` never touches the frontend. Password operations use the anon key or the user's own session token.

### 3.4 Local Username Credentials (LOCAL-CREDENTIALS-MODE-A)

Operational users who do not have a reliable real email address (and whose
institution's email delivery is unreliable in the current operating
environment) can be created as **local accounts** instead of email accounts.
Supabase Auth is still the only authentication backend — local accounts are
not a separate, custom auth system.

- The visible login identifier is a **username** (e.g. `ali.pharmacy`), shown
  to the user and stored in `profiles.username`.
- Supabase Auth still requires an email-shaped identifier internally. The app
  synthesizes one as `<username>@local.medistock.invalid` — a non-deliverable,
  technical identifier only. It is never shown to the user as a contact
  email and the app never claims mail can be delivered to it.
- `profiles.login_mode` records whether an account is `'email'` (default,
  real address, standard reset-by-email flow) or `'local'` (username +
  password, no email dependency).
- `profiles.contact_email`, when present, is purely informational (e.g. "call
  this address if you need to reach this person by other means") and is
  never used for login or password recovery.

**Exception to the "admins never see or set user passwords" rule:**
Because local accounts have no deliverable email, an admin must be able to
hand the user a **temporary password** at account creation/recycling time
(via `admin-create-user` / `admin-recycle-user`, server-side only). This is
the one deliberate, narrow carve-out from §3.3/§8 — admins set an initial
*temporary* password only, never read or change an existing password, and
the password is never logged, stored in `profiles`, or returned by any API
response. `profiles.must_change_password` is set `true` whenever a temporary
password is assigned, and the user is expected to change it from My Account
(`phoenix_mark_password_changed()` clears the flag after a successful
self-service change).

Forgot-password email recovery does not work for local accounts (the
synthetic email is not deliverable) — the user must ask their institution
administrator for a new temporary password instead. Real-email accounts keep
the existing self-service reset-by-email flow unchanged.

### 3.5 Recycling

Recycling is the process of reassigning a **suspended** account to a **different real person**. It must not be approximated by editing a profile's name/email directly.

**Why a dedicated workflow is required:**
- Old operations (status reports, QR scans, audit actions) reference the old person's identity.
- Directly changing `full_name` or `email` on an existing profile retroactively changes the attribution of all past operations — the new person would appear to have performed the old person's actions.
- A proper recycling workflow must first **snapshot the old identity**, then increment `profiles.identity_version`, then update the profile.

**Recycling workflow (via `admin-recycle-user` Edge Function):**
1. Target account must be suspended (disabled) before recycling.
2. Old identity is closed in `user_identity_history` (valid_until = now()).
3. `profiles.identity_version` is incremented.
4. Profile is updated with new person's `full_name`, `role`, and optionally `organization_id`.
5. Auth email is updated server-side via `admin.auth.admin.updateUserById`.
6. Auth ban is removed (account re-enabled).
7. Password setup link is sent to the new email.
8. All old operations retain their snapshot from before recycling; all new operations use the new identity.

**Required permission:** `users.recycle` (dangerous; super_admin default true; all others false by default).

**Password setup:** After recycling, the Edge Function calls `generateLink({ type: 'recovery' })` to create a password reset link for the new email. This generates the link server-side but does **not guarantee email delivery** — actual delivery depends on the Supabase project's SMTP configuration. The generated link is discarded (never returned to the admin). If the new user does not receive an email, the admin must send a password reset link manually from Supabase Auth settings. Admins never see or set the user's password.

**Partial-failure behavior:** Auth email is updated before DB changes. If DB changes fail after auth email update, the account remains suspended (still banned), and the admin can retry. The safest failure mode — no partial identity change is visible to users.

### 3.5 Hard Delete

Hard delete permanently removes the auth user from Supabase Auth. Because `profiles.id` references `auth.users(id) ON DELETE CASCADE`, the profile row is also deleted.

**Hard delete is NOT a normal operational action.**

**Why hard delete is avoided:**
- Operations in the system (status reports, QR actions, availability records, audit logs) store `profile_id` or `created_by` references. If the profile is deleted, those references become dangling — the operator cannot tell who performed an action.
- Unlike suspension, deletion is irreversible.
- There is no distinction in data between "this user was intentionally deleted" and "this user never existed."

**When hard delete is acceptable (platform operator only):**
- Cleaning up test accounts that were never used in production.
- Correcting an accidentally created duplicate account with no associated operations.
- Regulatory requirement with documented approval.

**Current UI status:** Hard delete is gated/hidden in the UI. The `deleteUserViaEdge` service function exists but the delete button is not rendered. This is intentional and must not be changed without a formal decision.

---

## 4. Why Hard Delete Is Avoided

| Concern | Suspend | Hard Delete |
|---|---|---|
| Reversible | ✅ Yes | ❌ No |
| Historical attribution preserved | ✅ Yes | ❌ No (dangling FKs or orphaned data) |
| Auth session immediately revoked | ✅ Yes (ban) | ✅ Yes |
| Profile row survives | ✅ Yes | ❌ No |
| Safe for accounts with past operations | ✅ Yes | ❌ No |
| Suitable for test accounts with no operations | ✅ Yes | ⚠ Acceptable (platform operator only) |

---

## 5. Why Normal Account Edit Must Not Be Used for Recycling

Editing `profiles.full_name` or `profiles.email` on an existing account without snapshotting first causes **retroactive identity substitution**:

- Reports submitted by the old person will appear under the new person's name.
- QR actions logged under the old identity will be attributed to the new person.
- Audit logs will no longer reflect the actual actor.

This is a **data integrity violation**, not merely a cosmetic issue. Any account reassignment must go through the dedicated recycling workflow that creates an identity snapshot before modifying the profile.

---

## 6. Future Identity Snapshot Requirement

See `docs/user-identity-snapshot-plan.md` for the full technical plan.

Summary:
- A `user_identity_history` table will record each identity version of every profile.
- A `profiles.identity_version` integer increments each time the profile is recycled.
- Operation tables that carry actor attribution must store snapshot fields (`actor_name_snapshot`, `actor_email_snapshot`, `actor_role_snapshot`, `actor_identity_version`) so historical records remain correct even after recycling.

---

## 7. Rollback and Safety Notes

| Action | Rollback |
|---|---|
| Disable | Re-enable via `admin-user-lifecycle` (enable action) |
| Correction (name/email) | Super admin re-edits to restore original value |
| Password reset | User sets a new password via the reset flow |
| Hard delete | ❌ Irreversible — auth user and profile are gone |
| Recycling (future) | Restore identity snapshot, decrement version |

**General principle:** Prefer reversible actions. Suspend before considering any permanent action. Never perform irreversible actions on accounts with operational history.

---

## 8. Prohibited Actions (All Roles)

- No role may use a direct `.delete()` on the `profiles` table from frontend code.
- No role may edit another user's profile via a direct `.update()` on the `profiles` table from frontend code (all user management goes through RPCs or Edge Functions).
- No role may see or set another user's raw password — except the one narrow, server-side carve-out in §3.4: an admin may set an initial *temporary* password for a local account at creation/recycling time. The temporary password is never logged, stored in `profiles`, or returned by any API response.
- No role may bypass the Edge Function and use `auth.admin` from frontend code.
- No role may use `service_role` or `SUPABASE_SERVICE_ROLE_KEY` in any frontend code; this key must exist only in the Deno edge runtime.
- No role may perform account recycling outside the dedicated workflow (once implemented).
