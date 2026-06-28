/* ─── MEDISTOCK PHOENIX — Local Username Credentials (LOCAL-CREDENTIALS-MODE-A) ─
   Local users log in with a username instead of a real email address.
   Supabase Auth still requires an email-shaped identifier internally, so the
   app synthesizes one from the username under a non-deliverable domain.
   This file is the single source of truth for that mapping — never construct
   the synthetic email by hand elsewhere.
   ──────────────────────────────────────────────────────────────────────────── */

/** Internal-only domain for synthetic local-account auth emails. Never a real mailbox. */
export const LOCAL_AUTH_DOMAIN = 'local.medistock.invalid';

const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

/** Trim + lowercase a raw username input. Does not validate shape. */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** True when the normalized username matches the allowed shape (a-z, 0-9, dot, underscore, dash; 3-32 chars). */
export function validateUsername(username: string): boolean {
  return USERNAME_PATTERN.test(normalizeUsername(username));
}

/**
 * Build the synthetic internal Supabase Auth email for a local username.
 * This is a technical auth identifier only — never show it as a contact
 * email or claim that mail can be delivered to it.
 */
export function localUsernameToAuthEmail(username: string): string {
  return `${normalizeUsername(username)}@${LOCAL_AUTH_DOMAIN}`;
}

/** True when a string is shaped like the synthetic local-auth email (used to hide it from display). */
export function isLocalAuthEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith(`@${LOCAL_AUTH_DOMAIN}`);
}

/**
 * Resolve whatever the user typed on the login screen into the identifier
 * Supabase Auth expects. Real emails (containing "@") pass through unchanged;
 * bare usernames are mapped to their synthetic internal email.
 */
export function resolveLoginIdentifier(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes('@')) return trimmed;
  return localUsernameToAuthEmail(trimmed);
}
