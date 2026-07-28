/**
 * MOVEMENT-WRITER-COMPLETENESS — the standing guard that closes the unified
 * movement contract for good.
 *
 * The eight domain slices (126-133) each proved their OWN writers. Nothing,
 * until now, proved that the set of writers was COMPLETE — and it was not:
 * running the discovery below for the first time surfaced
 * `phoenix_receive_outlet_return_shipment_line`, a live dual-ledger writer
 * that was never in the original audit of 20 and still wrote both ledgers
 * with no reason_code, no correlation_id and no causation_id. Migration 135
 * (Group I) fixes it; this file is what found it and what stops the next one.
 *
 * This is a STATIC guard: it parses the real migration corpus, so it runs in
 * CI with no database. The dynamic twin
 * (movement-writer-completeness.dynamic.test.ts) re-derives the same set from
 * pg_proc after a full replay and proves the runtime behaviour.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  REVIEWED_MOVEMENT_WRITERS,
  EXCLUDED_WRITERS,
  CONTRACT_LEDGERS,
  NON_CONTRACT_LEDGERS,
  CONTRACT_GROUPS,
  KNOWN_WRITER_NAMES,
  reviewedWriter,
  isReviewedWriter,
  isExcludedWriter,
  writersInGroup,
} from './helpers/reviewed-movement-writers';
import { PREPARED_ONLY_SKIP } from '../../../tools/pg-rig/rig.mjs';

const MIGRATIONS = join(__dirname, '..');

/** Migration files in applied order, excluding prepared-only cutover files. */
const migrationFiles = readdirSync(MIGRATIONS)
  .filter(f => /^\d{3}_.*\.sql$/.test(f))
  .filter(f => !(PREPARED_ONLY_SKIP as Set<string>).has(f))
  .sort();

const sourceOf = new Map<string, string>(
  migrationFiles.map(f => [f, readFileSync(join(MIGRATIONS, f), 'utf8')]),
);

const ALL_LEDGERS = [...CONTRACT_LEDGERS, ...NON_CONTRACT_LEDGERS];

interface FoundFn {
  fn: string;
  file: string;
  body: string;
  ledgers: string[];
}

type DefEvent = { at: number; kind: 'define'; fn: string; body: string };
type RenameEvent = { at: number; kind: 'rename'; from: string; to: string };
type Event = DefEvent | RenameEvent;

/**
 * Every function-identity event in one migration, in POSITIONAL order.
 *
 * Two things this must get right, both learned the hard way:
 *   * `CREATE FUNCTION` and `CREATE OR REPLACE FUNCTION` are both definitions
 *     — matching only the latter would let a new writer slip in unguarded.
 *   * `ALTER FUNCTION x(...) RENAME TO y` MOVES a body to a new identity
 *     (065 does exactly this to park the pre-provenance availability writer as
 *     ..._internal, then defines a delegating wrapper at the old name). A
 *     name-only scan mis-attributes both functions unless renames are
 *     replayed, and order within the file matters because 065 renames first
 *     and defines second.
 */
function eventsIn(file: string): Event[] {
  const src = sourceOf.get(file)!;
  const out: Event[] = [];

  const defRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = defRe.exec(src)) !== null) {
    const fn = m[1];
    // The body opens at the first dollar-quote tag introduced by AS after the
    // signature. `AS` sits on its own line in this corpus, so anchor on the
    // keyword + tag together rather than on surrounding spaces.
    const asRe = /\bAS\s+\$(\w*)\$/g;
    asRe.lastIndex = m.index;
    const asMatch = asRe.exec(src);
    if (!asMatch) continue;
    const tag = `$${asMatch[1]}$`;
    const bodyStart = asMatch.index + asMatch[0].length;
    const bodyEnd = src.indexOf(tag, bodyStart);
    if (bodyEnd < 0) continue;
    out.push({ at: m.index, kind: 'define', fn, body: src.slice(bodyStart, bodyEnd) });
  }

  const renRe = /ALTER\s+FUNCTION\s+public\.(\w+)\s*\([^)]*\)\s*RENAME\s+TO\s+(\w+)/gis;
  while ((m = renRe.exec(src)) !== null) {
    out.push({ at: m.index, kind: 'rename', from: m[1], to: m[2] });
  }

  return out.sort((a, b) => a.at - b.at);
}

/** Ledgers a body INSERTs into. */
function ledgersWritten(body: string): string[] {
  return ALL_LEDGERS.filter(l =>
    new RegExp(`INSERT\\s+INTO\\s+(public\\.)?${l}\\b`, 'i').test(body),
  );
}

/**
 * The FINAL definition of every function in the corpus, after replaying all
 * definitions and renames in migration order — i.e. what Postgres actually
 * ends up holding. Ledger classification is applied to that final body only:
 * a function that STOPS writing a ledger (065's wrapper) must stop counting
 * as a writer, which an "only remember ledger-writing definitions" model gets
 * wrong forever.
 */
const finalDefs: Map<string, { file: string; body: string }> = (() => {
  const acc = new Map<string, { file: string; body: string }>();
  for (const file of migrationFiles) {
    for (const ev of eventsIn(file)) {
      if (ev.kind === 'define') {
        acc.set(ev.fn, { file, body: ev.body });
      } else {
        const moved = acc.get(ev.from);
        if (moved) {
          acc.set(ev.to, moved);
          acc.delete(ev.from);
        }
      }
    }
  }
  return acc;
})();

/**
 * Migration 149 wraps selected public writers with a pre-lock capsule and
 * parks their byte-preserved movement implementation under a private delegate.
 * For contract discovery the two functions are one writer: the public wrapper
 * owns the callable identity/lock prelude and the private delegate owns the
 * ledger mutation. Compose both bodies and remove the implementation detail so
 * neither side can evade the existing completeness checks.
 */
for (const writer of REVIEWED_MOVEMENT_WRITERS) {
  const wrapper = finalDefs.get(writer.fn);
  const delegateName =
    `_phoenix_149_delegate_${writer.fn.replace(/^phoenix_/, '')}`;
  const delegate = finalDefs.get(delegateName);
  if (!wrapper || !delegate) continue;
  finalDefs.set(writer.fn, {
    file: wrapper.file,
    body: `${wrapper.body}\n${delegate.body}`,
  });
  finalDefs.delete(delegateName);
}

const latestWriters: Map<string, FoundFn> = (() => {
  const acc = new Map<string, FoundFn>();
  for (const [fn, { file, body }] of finalDefs) {
    const ledgers = ledgersWritten(body);
    if (ledgers.length === 0) continue;
    acc.set(fn, { fn, file, body, ledgers });
  }
  return acc;
})();

const contractWriters = [...latestWriters.values()].filter(w =>
  w.ledgers.some(l => (CONTRACT_LEDGERS as string[]).includes(l)),
);

// ============================================================================
// 1. Discovery ↔ registry agree in BOTH directions
// ============================================================================

describe('1. every ledger-writing function on disk is reviewed, and every reviewed writer exists', () => {
  it('discovers a non-trivial number of writers (the scan itself is not silently broken)', () => {
    expect(latestWriters.size).toBeGreaterThanOrEqual(20);
  });

  it('NO unreviewed function writes a contract ledger', () => {
    const unreviewed = contractWriters
      .map(w => w.fn)
      .filter(fn => !isReviewedWriter(fn) && !isExcludedWriter(fn))
      .sort();
    expect(unreviewed).toEqual([]);
  });

  it('NO unreviewed function writes a NON-contract ledger either (exclusions must be explicit)', () => {
    const unknown = [...latestWriters.values()]
      .filter(w => w.ledgers.every(l => (NON_CONTRACT_LEDGERS as string[]).includes(l)))
      .map(w => w.fn)
      .filter(fn => !isExcludedWriter(fn) && !isReviewedWriter(fn))
      .sort();
    expect(unknown).toEqual([]);
  });

  it('every reviewed writer still exists on disk (none silently deleted or renamed)', () => {
    const missing = REVIEWED_MOVEMENT_WRITERS
      .map(w => w.fn)
      .filter(fn => !latestWriters.has(fn))
      .sort();
    expect(missing).toEqual([]);
  });

  it('every excluded writer still exists on disk', () => {
    const missing = EXCLUDED_WRITERS
      .map(w => w.fn)
      .filter(fn => !latestWriters.has(fn))
      .sort();
    expect(missing).toEqual([]);
  });

  it('the registry contains no duplicates', () => {
    const names = KNOWN_WRITER_NAMES;
    expect(names.length).toBe(new Set(names).size);
  });

  it('no function is both reviewed and excluded', () => {
    const both = REVIEWED_MOVEMENT_WRITERS.map(w => w.fn).filter(isExcludedWriter);
    expect(both).toEqual([]);
  });
});

// ============================================================================
// 2. The registry's own claims match the code it describes
// ============================================================================

describe('2. each reviewed writer targets exactly the ledgers the registry claims', () => {
  for (const w of REVIEWED_MOVEMENT_WRITERS) {
    it(`${w.fn} writes exactly [${[...w.ledgers].sort().join(', ')}]`, () => {
      const found = latestWriters.get(w.fn)!;
      const actual = found.ledgers.filter(l => (CONTRACT_LEDGERS as string[]).includes(l)).sort();
      expect(actual).toEqual([...w.ledgers].sort());
    });
  }
});

describe('3. each excluded writer touches ONLY non-contract ledgers', () => {
  for (const w of EXCLUDED_WRITERS) {
    it(`${w.fn} never writes a contract ledger`, () => {
      const found = latestWriters.get(w.fn)!;
      const contract = found.ledgers.filter(l => (CONTRACT_LEDGERS as string[]).includes(l));
      expect(contract).toEqual([]);
    });
    it(`${w.fn} states a substantive exclusion reason`, () => {
      expect(w.reason.length).toBeGreaterThan(40);
    });
  }
});

// ============================================================================
// 4. Contract-field presence — the substance of the eight/nine slices
// ============================================================================

describe('4. every reviewed writer references every contract field', () => {
  for (const w of REVIEWED_MOVEMENT_WRITERS) {
    it(`${w.fn} writes reason_code`, () => {
      expect(latestWriters.get(w.fn)!.body).toMatch(/\breason_code\b/);
    });

    it(`${w.fn} writes correlation_id`, () => {
      expect(latestWriters.get(w.fn)!.body).toMatch(/\bcorrelation_id\b/);
    });

    it(`${w.fn} ${w.causation === null ? 'is a root op (no causation anchor claimed)' : 'writes causation_id'}`, () => {
      const body = latestWriters.get(w.fn)!.body;
      if (w.causation === null) {
        // A root operation must NOT silently claim a causation it cannot have.
        expect(w.correlation).toBe('fresh');
      } else {
        expect(body).toMatch(/\bcausation_id\b/);
      }
    });
  }
});

describe('5. reason_code sourcing matches the registry', () => {
  for (const w of REVIEWED_MOVEMENT_WRITERS) {
    const body = () => latestWriters.get(w.fn)!.body;
    if (w.reasonCode.kind === 'literal') {
      it(`${w.fn} hardcodes reason_code '${w.reasonCode.value}'`, () => {
        expect(body()).toContain(`'${w.reasonCode.kind === 'literal' ? w.reasonCode.value : ''}'`);
      });
    } else if (w.reasonCode.kind === 'parameter') {
      it(`${w.fn} takes reason_code via ${w.reasonCode.param}`, () => {
        expect(body()).toContain(w.reasonCode.kind === 'parameter' ? w.reasonCode.param : '');
      });
    } else {
      it(`${w.fn} propagates reason_code from an already-closed upstream value`, () => {
        // Propagating writers must not invent a literal vocabulary value;
        // they read one. Assert they reference a reason_code-bearing variable
        // rather than only a bare string literal.
        expect(body()).toMatch(/(v_reason_code|\.reason_code|quarantine_reason)/);
      });
    }
  }
});

// ============================================================================
// 6. Safety invariants no writer may regress
// ============================================================================

describe('6. every reviewed writer keeps its SECURITY DEFINER hardening', () => {
  for (const w of REVIEWED_MOVEMENT_WRITERS) {
    it(`${w.fn} is SECURITY DEFINER with a pinned search_path`, () => {
      // Look at the declaration, which sits just before the body.
      const src = sourceOf.get(latestWriters.get(w.fn)!.file)!;
      const declRe = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${w.fn}\\s*\\(`, 'g');
      let declIdx = -1;
      let dm: RegExpExecArray | null;
      while ((dm = declRe.exec(src)) !== null) declIdx = dm.index; // last one wins
      expect(declIdx, `${w.fn} declaration not found`).toBeGreaterThanOrEqual(0);
      const decl = src.slice(declIdx, declIdx + 3000);
      expect(decl).toMatch(/SECURITY DEFINER/);
      expect(decl).toMatch(/SET search_path\s*=\s*public,\s*pg_temp/);
    });
  }
});

describe('7. idempotency and concurrency claims hold', () => {
  for (const w of REVIEWED_MOVEMENT_WRITERS) {
    it(`${w.fn} ${w.idempotency === 'request_fingerprint' ? 'owns a request_fingerprint' : 'delegates idempotency and is NOT client-callable'}`, () => {
      const body = latestWriters.get(w.fn)!.body;
      if (w.idempotency === 'request_fingerprint') {
        expect(body).toMatch(/request_fingerprint/);
      } else {
        // Delegation is only acceptable for an internal helper.
        expect(w.clientCallable).toBe(false);
      }
    });

    it(`${w.fn} takes ${w.concurrency}`, () => {
      const body = latestWriters.get(w.fn)!.body;
      expect(body).toMatch(/FOR UPDATE/);
      if (w.concurrency === 'advisory-lock+row-lock') {
        expect(body).toMatch(/pg_advisory_xact_lock/);
      }
    });
  }
});

describe('8. no writer performs a client-facing positional or unguarded insert', () => {
  for (const w of REVIEWED_MOVEMENT_WRITERS) {
    it(`${w.fn} names its ledger columns explicitly (never a positional INSERT)`, () => {
      const body = latestWriters.get(w.fn)!.body;
      for (const ledger of w.ledgers) {
        const re = new RegExp(`INSERT\\s+INTO\\s+(public\\.)?${ledger}\\s*\\(`, 'i');
        expect(body, `${w.fn} → ${ledger}`).toMatch(re);
      }
    });
  }
});

describe('9. no reviewed writer is granted to PUBLIC or anon anywhere in the corpus', () => {
  for (const w of REVIEWED_MOVEMENT_WRITERS) {
    it(`${w.fn} has no GRANT to PUBLIC/anon`, () => {
      for (const file of migrationFiles) {
        const src = sourceOf.get(file)!;
        const re = new RegExp(
          `GRANT[^;]*ON FUNCTION[^;]*\\b${w.fn}\\b[^;]*TO[^;]*\\b(PUBLIC|anon)\\b`,
          'i',
        );
        expect(src, `${file} grants ${w.fn} to PUBLIC/anon`).not.toMatch(re);
      }
    });
  }
});

// ============================================================================
// 10. Group coverage — the contract is organised, not ad hoc
// ============================================================================

describe('10. every contract group has at least one reviewed writer', () => {
  for (const g of CONTRACT_GROUPS) {
    it(`group ${g} is non-empty`, () => {
      expect(writersInGroup(g).length).toBeGreaterThan(0);
    });
  }

  it('every reviewed writer belongs to a known group', () => {
    const strays = REVIEWED_MOVEMENT_WRITERS
      .filter(w => !(CONTRACT_GROUPS as string[]).includes(w.group))
      .map(w => `${w.fn}:${w.group}`);
    expect(strays).toEqual([]);
  });

  it('every reviewed writer names the migration that made it compliant, within the reviewed range', () => {
    for (const w of REVIEWED_MOVEMENT_WRITERS) {
      expect(w.migration, w.fn).toBeGreaterThanOrEqual(126);
      expect(w.migration, w.fn).toBeLessThanOrEqual(135);
    }
  });
});

// ============================================================================
// 11. Negative controls — the guard genuinely fails when it should
// ============================================================================

describe('11. the guard is not vacuous', () => {
  it('a synthetic unreviewed contract writer would be caught', () => {
    const synthetic = 'phoenix_totally_new_unreviewed_writer';
    expect(isReviewedWriter(synthetic)).toBe(false);
    expect(isExcludedWriter(synthetic)).toBe(false);
  });

  it('ledger detection actually matches a real INSERT and rejects a lookalike', () => {
    expect(ledgersWritten('INSERT INTO public.warehouse_stock_movements (a) VALUES (1)'))
      .toEqual(['warehouse_stock_movements']);
    // A SELECT is not a write.
    expect(ledgersWritten('SELECT * FROM warehouse_stock_movements')).toEqual([]);
    // A different table with a shared prefix is not a match.
    expect(ledgersWritten('INSERT INTO public.warehouse_stock (a) VALUES (1)')).toEqual([]);
  });

  it('the parser really extracted bodies (not empty strings that would pass every regex trivially)', () => {
    for (const w of REVIEWED_MOVEMENT_WRITERS) {
      expect(latestWriters.get(w.fn)!.body.length, w.fn).toBeGreaterThan(400);
    }
  });

  it('Group I exists and is exactly the writer this guard discovered', () => {
    expect(writersInGroup('I').map(w => w.fn)).toEqual([
      'phoenix_receive_outlet_return_shipment_line',
    ]);
    expect(reviewedWriter('phoenix_receive_outlet_return_shipment_line')!.migration).toBe(135);
  });
});
