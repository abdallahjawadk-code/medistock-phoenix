/**
 * INTER-ORG-OPPORTUNITY-REGULATORY-NOTICE
 * Run: npm test -- --run
 *
 * Static source tests for the regulatory banner on
 * InterInstitutionAlertsScreen — the peer-institution DISCOVERY layer.
 *
 * Two things make this screen different from the transfer-suggestion panel,
 * and both are asserted here rather than trusted:
 *
 *   1. VOCABULARY. This screen speaks of an "opportunity" (فرصة) and an
 *      "alert" (تنبيه) — never a "suggestion" or a "recommendation". That is
 *      why it does NOT reuse ts_regulatory_notice: that string calls the item
 *      a transfer suggestion, which would contradict this screen's contract.
 *      lia_regulatory_notice carries the same regulatory duty in this screen's
 *      own words.
 *
 *   2. NO ACKNOWLEDGEMENT TICK. The mandatory checkbox belongs to
 *      InventoryDraftDocumentDialog, where a draft is actually created. This
 *      screen creates nothing and has no execution corridor, so there is no
 *      action to gate — a tick here would be theatre.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const screen = readSrc('features/alerts/InterInstitutionAlertsScreen.tsx');
const stringLines = readSrc('shared/i18n/strings.ts').split('\n');

const FORBIDDEN = ['اقتراح', 'توصية', 'recommendation', 'suggestion'];
const BANNER = 'data-testid="lia-regulatory-banner"';

const at = (needle: string) => screen.indexOf(needle);
const countOf = (needle: string) => screen.split(needle).length - 1;
const stringLineFor = (key: string) => stringLines.find(l => l.trimStart().startsWith(key + ':'));
const bannerBlock = () => screen.slice(at(BANNER), at(BANNER) + 900);

/** Every i18n key this screen actually renders, resolved without a regex. */
const renderedKeys = (): string[] => {
  const out = new Set<string>();
  const parts = screen.split("t('");
  for (let i = 1; i < parts.length; i += 1) {
    const end = parts[i].indexOf("'");
    if (end > 0) out.add(parts[i].slice(0, end));
  }
  return [...out];
};

describe('1 - one regulatory banner, above everything else', () => {
  it('renders exactly ONE banner for the whole screen, never one per card', () => {
    expect(countOf(BANNER)).toBe(1);
  });

  it('places it above the discovery-only notice, the no-execution notice and the filters', () => {
    const banner = at("t('lia_regulatory_notice'");
    const discovery = at("t('iia_no_transfer'");
    const noExec = at("t('lia_not_executable_note'");
    const filters = at("t('lia_severity_label'");
    expect(banner).toBeGreaterThan(-1);
    expect(banner).toBeLessThan(discovery);
    expect(discovery).toBeLessThan(noExec);
    expect(noExec).toBeLessThan(filters);
  });

  it('is an assertive alert, so it is not read as one more quiet note', () => {
    expect(screen.slice(at(BANNER) - 200, at(BANNER))).toContain('role="alert"');
  });
});

describe('2 - uses lia_regulatory_notice and keeps the opportunity-only contract', () => {
  it('renders this screen own regulatory title and body', () => {
    expect(screen).toContain("t('lia_regulatory_title', lang)");
    expect(screen).toContain("t('lia_regulatory_notice', lang)");
  });

  // Asserted on the RENDER, not on raw presence: the banner's own comment names
  // ts_regulatory_notice to explain why it is deliberately not used here, and a
  // blunt "does not contain" would fail on that explanation. What must never
  // happen is the screen actually rendering it.
  it('never renders ts_regulatory_notice here', () => {
    expect(screen).not.toContain("t('ts_regulatory_notice'");
  });

  it('defines both new keys bilingually', () => {
    for (const key of ['lia_regulatory_title', 'lia_regulatory_notice']) {
      const line = stringLineFor(key);
      expect(line, 'missing i18n key: ' + key).toBeTruthy();
      expect(line).toContain('ar:');
      expect(line).toContain('en:');
    }
  });

  it('states the regulatory duty in opportunity words, in BOTH languages', () => {
    const line = stringLineFor('lia_regulatory_notice') as string;
    expect(line).toContain('فرصة');
    expect(line).toContain('opportunity');
  });

  // The pre-existing Phase 2 guard already bans موافقة across every lia_*
  // string. It does NOT ban the English "approval", so that half is pinned
  // here: this screen denies AUTHORISATION, and must not name an approval it
  // has no workflow for. Both halves say the same thing in both languages.
  it('denies authorisation without borrowing approval-workflow vocabulary', () => {
    const line = stringLineFor('lia_regulatory_notice') as string;
    expect(line).not.toContain('موافقة');
    expect(line.toLowerCase()).not.toContain('approval');
    expect(line).toContain('إذناً');
    expect(line.toLowerCase()).toContain('authorization');
  });
});

describe('3 - both pre-existing notices survive untouched', () => {
  it('keeps the discovery-only notice', () => {
    expect(screen).toContain("t('iia_no_transfer', lang)");
    expect(stringLineFor('iia_no_transfer')).toBeTruthy();
  });

  it('keeps the no-direct-execution notice', () => {
    expect(screen).toContain("t('lia_not_executable_note', lang)");
    expect(stringLineFor('lia_not_executable_note')).toBeTruthy();
  });
});

describe('4 - no suggestion/recommendation vocabulary reaches this screen', () => {
  it('resolves EVERY key the screen renders and finds the forbidden words in none', () => {
    const keys = renderedKeys();
    expect(keys.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const key of keys) {
      const line = stringLineFor(key);
      expect(line, 'unresolved i18n key: ' + key).toBeTruthy();
      for (const word of FORBIDDEN) {
        if ((line as string).toLowerCase().includes(word.toLowerCase())) {
          offenders.push(key + ' -> ' + word);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('5 - presentation only: nothing was wired to data', () => {
  it('adds no direct supabase call, no RPC and no write', () => {
    for (const forbidden of ['.rpc(', 'supabase.', '.insert(', '.update(', '.delete(', '.upsert(']) {
      expect(screen, 'unexpected data call: ' + forbidden).not.toContain(forbidden);
    }
  });

  it('still reads through the CQRS query/command service only', () => {
    expect(screen).toContain("from './inter-org-alert-lifecycle.service'");
  });

  it('adds NO acknowledgement checkbox here - that gate belongs to the draft dialog', () => {
    expect(screen).not.toContain('type="checkbox"');
    expect(screen).not.toContain('inv-draft-reg-ack');
  });
});

describe('6 - renders responsively on mobile and desktop', () => {
  it('sizes the banner from the same isMobile breakpoint the screen already uses', () => {
    const block = bannerBlock();
    expect(block).toContain('isMobile ?');
    expect(block).toContain("width: '100%'");
    expect(block).toContain("boxSizing: 'border-box'");
  });
});

describe('7 - Arabic RTL and English LTR', () => {
  it('lets the banner follow the document direction instead of pinning one', () => {
    expect(bannerBlock()).toContain('dir="auto"');
  });

  it('uses a LOGICAL inline border so the accent flips with the language', () => {
    const block = bannerBlock();
    expect(block).toContain('borderInlineStartWidth');
    expect(block).not.toContain('borderLeft');
    expect(block).not.toContain('borderRight');
  });

  it('introduces no physical-direction spacing anywhere on the screen', () => {
    for (const physical of ['marginLeft', 'marginRight', 'paddingLeft', 'paddingRight']) {
      expect(screen, 'physical direction property: ' + physical).not.toContain(physical);
    }
  });
});
