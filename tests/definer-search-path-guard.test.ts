import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * SECURITY-ARCH-HARDENING-A — SECURITY DEFINER search_path regression guard.
 *
 * A `SECURITY DEFINER` function runs with the privileges of its owner (here,
 * the migration/superuser role), so if it references objects unqualified and
 * does NOT pin `search_path`, a lower-privileged caller who can create objects
 * in an earlier-resolved schema (classically a writable `public` or a
 * `pg_temp` table) can shadow those objects and have the definer execute
 * attacker-controlled code — a privilege-escalation / search_path-injection
 * vector (CWE-426 / Supabase "Function Search Path Mutable" lint).
 *
 * The audit (2026-07-22) confirmed every one of the ~171 SECURITY DEFINER
 * functions currently pins `search_path` in its FINAL definition. There was,
 * however, no automated guard preventing a future migration from adding one
 * that omits it. This test is that guard: it parses every migration, resolves
 * each function's last definition, and fails loudly if any SECURITY DEFINER
 * function does not set `search_path` (either inline in the CREATE, or via a
 * trailing `ALTER FUNCTION ... SET search_path`).
 *
 * This test intentionally makes NO SQL/schema/grant change — it only encodes
 * the invariant the codebase already satisfies.
 */

const MIGRATIONS = join(__dirname, '../supabase/migrations');

interface FinalDef {
  file: string;
  isDefiner: boolean;
  pinsSearchPath: boolean;
}

const CREATE_FN = /create\s+(?:or\s+replace\s+)?function\s+([a-z0-9_."]+)\s*\(/gi;
const ALTER_SP =
  /alter\s+function\s+([a-z0-9_."]+)\s*\([^)]*\)\s*set\s+search_path/gi;

function normalizeName(raw: string): string {
  // Strip a leading schema qualifier and any quoting, lower-case for keying.
  return raw.replace(/"/g, '').toLowerCase().replace(/^public\./, '');
}

function scan(): { final: Map<string, FinalDef>; altered: Set<string> } {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const final = new Map<string, FinalDef>();
  const altered = new Set<string>();

  for (const file of files) {
    const text = readFileSync(join(MIGRATIONS, file), 'utf8');

    // Collect the start offset of every CREATE FUNCTION so we can bound blocks.
    const starts: { name: string; index: number }[] = [];
    for (const m of text.matchAll(CREATE_FN)) {
      starts.push({ name: normalizeName(m[1]), index: m.index ?? 0 });
    }
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i].index;
      const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
      const block = text.slice(start, end).toLowerCase();
      final.set(starts[i].name, {
        file,
        isDefiner: /security\s+definer/.test(block),
        pinsSearchPath: /set\s+search_path/.test(block),
      });
    }

    for (const m of text.matchAll(ALTER_SP)) {
      altered.add(normalizeName(m[1]));
    }
  }

  return { final, altered };
}

describe('SECURITY DEFINER functions pin search_path (privilege-escalation guard)', () => {
  const { final, altered } = scan();

  const definerFns = [...final.entries()].filter(([, d]) => d.isDefiner);

  it('parses a non-trivial set of SECURITY DEFINER functions (parser sanity)', () => {
    // Guards against a silently-broken parser reporting a false "all clear".
    expect(definerFns.length).toBeGreaterThan(100);
  });

  it('every SECURITY DEFINER function pins search_path in its final definition', () => {
    const offenders = definerFns
      .filter(([name, d]) => !d.pinsSearchPath && !altered.has(name))
      .map(([name, d]) => `${name} (last defined in ${d.file})`);

    expect(offenders, `SECURITY DEFINER functions missing SET search_path:\n${offenders.join('\n')}`).toEqual([]);
  });
});
