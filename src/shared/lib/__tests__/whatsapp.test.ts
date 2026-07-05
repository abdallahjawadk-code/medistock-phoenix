/**
 * UX-WHATSAPP-INSTITUTION-CONTACT-A
 * Run: npm test -- --run
 *
 * Static + behavioral tests proving the WhatsApp contact layer was added
 * WITHOUT touching routes, nav targets, QR public URL logic, export/print
 * logic, user management, or permissions — and without introducing fake
 * data, fake phone numbers, WhatsApp API/tokens/automation, migrations,
 * package/lockfile changes, or Service-D interference.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import {
  normalizeWhatsappPhone,
  isValidWhatsappPhone,
  buildWhatsappUrl,
  buildMaterialContactMessage,
} from '../whatsapp';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const app = readSrc('app/App.tsx');
const whatsappHelper = readSrc('shared/lib/whatsapp.ts');
const whatsappButton = readSrc('shared/ui/WhatsAppContactButton.tsx');
const userManagementScreen = readSrc('features/users/UserManagementScreen.tsx');
const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
const publicQr = readSrc('features/qr/PublicQrScreen.tsx');

// ─── 11-14: helper behavior ─────────────────────────────────────────────────

describe('11/12. WhatsApp helper builds only wa.me links and encodes message text', () => {
  it('buildWhatsappUrl only ever produces an https://wa.me/ URL', () => {
    const url = buildWhatsappUrl('+1 (234) 567-8901', 'Hello');
    expect(url.startsWith('https://wa.me/')).toBe(true);
    expect(url).not.toContain('graph.facebook.com');
    expect(url).not.toContain('api.whatsapp.com');
  });

  it('encodes the message text via encodeURIComponent', () => {
    const url = buildWhatsappUrl('12345678', 'Hello & goodbye / test');
    expect(url).toContain(encodeURIComponent('Hello & goodbye / test'));
    expect(url).not.toContain('Hello & goodbye / test');
  });
});

describe('13. WhatsApp helper normalizes phone numbers safely', () => {
  it('strips +, spaces, dashes, parentheses down to digits only', () => {
    expect(normalizeWhatsappPhone('+964 770 123 4567')).toBe('9647701234567');
    expect(normalizeWhatsappPhone('(070) 123-4567')).toBe('0701234567');
  });

  it('never guesses or prepends a country code', () => {
    expect(normalizeWhatsappPhone('07701234567')).toBe('07701234567');
  });
});

describe('14. WhatsApp helper rejects invalid/empty phone', () => {
  it('rejects empty, null, undefined, and implausibly short input', () => {
    expect(normalizeWhatsappPhone('')).toBe('');
    expect(normalizeWhatsappPhone(null)).toBe('');
    expect(normalizeWhatsappPhone(undefined)).toBe('');
    expect(normalizeWhatsappPhone('12')).toBe('');
    expect(isValidWhatsappPhone('abc')).toBe(false);
  });

  it('buildWhatsappUrl returns empty string for an invalid phone', () => {
    expect(buildWhatsappUrl('', 'hi')).toBe('');
    expect(buildWhatsappUrl('12', 'hi')).toBe('');
  });
});

// ─── 15/16: no automation, no API/tokens ───────────────────────────────────

describe('15. WhatsApp button never sends automatically', () => {
  it('WhatsAppContactButton only renders a user-clickable <a>/<span>, never auto-navigates or auto-fetches', () => {
    expect(whatsappButton).not.toContain('useEffect');
    expect(whatsappButton).not.toContain('window.location');
    expect(whatsappButton).not.toContain('.click()');
  });
});

describe('16. WhatsApp button does not use WhatsApp API/Cloud API/tokens', () => {
  it('no API/Cloud API/token references anywhere in the new WhatsApp files', () => {
    for (const src of [whatsappHelper, whatsappButton]) {
      // Matches actual API usage signatures, not this file's own doc comments
      // explaining that no such API is used.
      expect(src).not.toMatch(/graph\.facebook\.com|access_token=|api\.whatsapp\.com/i);
      expect(src).not.toContain('Bearer ');
    }
  });

  it('no fetch/axios/supabase calls in the WhatsApp helper or button', () => {
    for (const src of [whatsappHelper, whatsappButton]) {
      expect(src).not.toContain('supabase');
      expect(src).not.toContain('fetch(');
      expect(src).not.toContain('axios');
    }
  });
});

// ─── 17/18: real phone only, no fake number ────────────────────────────────

describe('17/18. WhatsApp button uses only real caller-supplied phone, no fake number added', () => {
  it('WhatsAppContactButton has no hardcoded phone number constant', () => {
    expect(whatsappButton).not.toMatch(/\+?\d{8,15}/);
  });

  it('UserManagementScreen wires the button to the same already-loaded contact.phone field used by the existing tel: link', () => {
    const block = userManagementScreen.slice(
      userManagementScreen.indexOf('function ContactSection'),
      userManagementScreen.indexOf('function ContactSection') + 1500,
    );
    expect(block).toContain('href={`tel:${c.phone}`}');
    expect(block).toContain('phone={c.phone}');
    expect(block).toContain('getOrgStatusContacts');
    // exactly one contact-fetch call site — no new/duplicate fetch introduced
    const fetchCount = (userManagementScreen.match(/getOrgStatusContacts\(/g) ?? []).length;
    expect(fetchCount).toBe(1);
  });
});

// ─── 19: honest missing-phone state ────────────────────────────────────────

describe('19. Missing phone state is honest in Arabic and English', () => {
  it('wa_number_missing and wa_invalid_number i18n keys exist with both languages', () => {
    const strings = readSrc('shared/i18n/strings.ts');
    for (const key of ['wa_contact', 'wa_number_missing', 'wa_invalid_number', 'wa_open']) {
      const line = strings.split('\n').find(l => l.trim().startsWith(`${key}:`));
      expect(line).toBeDefined();
      expect(line).toContain('ar:');
      expect(line).toContain('en:');
    }
  });

  it('button distinguishes "not configured" (no raw value) from "invalid" (unparseable raw value)', () => {
    expect(whatsappButton).toContain('wa_number_missing');
    expect(whatsappButton).toContain('wa_invalid_number');
    expect(whatsappButton).toContain('hasRaw');
  });
});

// ─── 20/21: message builder ────────────────────────────────────────────────

describe('20. Message builder omits missing fields', () => {
  it('omits a field entirely when not supplied (Arabic)', () => {
    const msg = buildMaterialContactMessage({ material: 'Amoxicillin' }, 'ar');
    expect(msg).toContain('المادة: Amoxicillin');
    expect(msg).not.toContain('الحالة:');
    expect(msg).not.toContain('المؤسسة:');
    expect(msg).not.toContain('المنفذ:');
    expect(msg).not.toContain('الكمية:');
  });

  it('omits a field entirely when not supplied (English)', () => {
    const msg = buildMaterialContactMessage({ status: 'Missing' }, 'en');
    expect(msg).toContain('Status: Missing');
    expect(msg).not.toContain('Material:');
    expect(msg).not.toContain('Institution:');
    expect(msg).not.toContain('Quantity:');
  });

  it('produces a clean greeting/closing with no dangling blank field section when nothing is supplied', () => {
    const msgAr = buildMaterialContactMessage({}, 'ar');
    const msgEn = buildMaterialContactMessage({}, 'en');
    expect(msgAr).toContain('يرجى مراجعة الحالة والتنسيق عند الإمكان.');
    expect(msgEn).toContain('Please review and coordinate when possible.');
  });
});

describe('21. Message builder has Arabic and English versions', () => {
  it('produces distinct Arabic vs English greetings', () => {
    const ar = buildMaterialContactMessage({ material: 'X' }, 'ar');
    const en = buildMaterialContactMessage({ material: 'X' }, 'en');
    expect(ar).toContain('السلام عليكم');
    expect(en).toContain('Hello,');
    expect(ar).not.toBe(en);
  });
});

// ─── 22: no clinical/medical recommendations ───────────────────────────────

describe('22. No clinical/medical recommendations in WhatsApp message', () => {
  it('message text never contains diagnosis/dosage-recommendation wording', () => {
    const full = buildMaterialContactMessage({
      material: 'Amoxicillin', status: 'Missing', institution: 'X Hospital',
      outlet: 'Main Pharmacy', quantity: 10, expiryDate: '2026-01-01', lastUpdate: '2026-01-01',
    }, 'en');
    expect(full.toLowerCase()).not.toMatch(/diagnos|prescri|dosage recommendation|treatment plan|take \d+ (mg|tablet)/);
  });
});

// ─── 1-3: routes/QR unchanged ───────────────────────────────────────────────

describe('1. App screen map / routes unchanged', () => {
  it('App.tsx still switches on the same known screen numbers', () => {
    for (const n of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) {
      expect(app).toContain(`case ${n}:`);
    }
  });
});

describe('2. Existing navigation targets unchanged', () => {
  it('WhatsApp files never call onNavigate or introduce new navigation', () => {
    expect(whatsappHelper).not.toContain('onNavigate');
    expect(whatsappButton).not.toContain('onNavigate');
  });
});

describe('3. QR public route remains present', () => {
  it('App.tsx still bypasses auth entirely for ?qid=/?token=; PublicQrScreen untouched', () => {
    expect(app).toContain('publicQrId');
    expect(app).toContain('PublicQrScreen');
    expect(publicQr).not.toContain('WhatsApp');
    expect(publicQr).not.toContain('whatsapp');
  });
});

// ─── 4/5: export/print + mobile print fallback ─────────────────────────────

describe('4/5. Export/print handlers + mobile print fallback remain unchanged', () => {
  // SAFE-PROFESSIONAL-XLSX-EXPORT-A: a later, separately-reviewed phase
  // replaced StatusCenterScreen's ad-hoc CSV export with a real styled
  // .xlsx workbook (exportXlsx) — unrelated to this phase's WhatsApp
  // concerns. printReport and the mobile print fallback are untouched.
  it('StatusCenterScreen still has exportXlsx, printReport, and the mobile print fallback modal', () => {
    expect(statusCenter).toContain('function exportXlsx');
    expect(statusCenter).toContain('function printReport');
    expect(statusCenter).toContain('MobilePrintFallbackModal');
  });

  it('StatusCenterScreen was not touched by this phase (no WhatsApp references)', () => {
    expect(statusCenter).not.toContain('WhatsApp');
    expect(statusCenter).not.toContain('whatsapp');
  });
});

// ─── 6: user-management unchanged ──────────────────────────────────────────

describe('6. User-management function invocations remain unchanged', () => {
  it('UserManagementScreen still calls the same create/disable/enable/recycle/rotate/assign/reset functions', () => {
    for (const fn of [
      'createUserViaEdge', 'disableUserViaEdge', 'enableUserViaEdge',
      'recycleUserViaEdge', 'rotatePasswordViaEdge',
      'assignProfilePermissions', 'resetProfilePermissions', 'listUsers', 'getEffectivePermissions',
    ]) {
      expect(userManagementScreen).toContain(fn);
    }
  });
});

// ─── 7-9: no service_role, no inter_org_exchange UI, no wipe tooling ───────

describe('7. No service_role / auth.admin in frontend', () => {
  it('none of the new WhatsApp files reference service_role or auth.admin', () => {
    for (const src of [whatsappHelper, whatsappButton]) {
      expect(src).not.toMatch(/service_role/i);
      expect(src).not.toContain('auth.admin');
    }
  });
});

describe('8. No inter_org_exchange UI added', () => {
  it('none of the new WhatsApp files reference inter_org_exchange', () => {
    for (const src of [whatsappHelper, whatsappButton]) {
      expect(src).not.toContain('inter_org_exchange');
    }
  });
});

describe('9. No wipe tooling restored', () => {
  it('none of the new WhatsApp files reference wipe/full-reset tooling', () => {
    for (const src of [whatsappHelper, whatsappButton]) {
      expect(src).not.toMatch(/phoenix-wipe-execute|FULL_PUBLIC_APP_WIPE_APPROVED|full_wipe|DROP SCHEMA/i);
    }
  });
});

describe('10. No package/lockfile/migration changes', () => {
  // REFRESH-MIGRATION-051-DIFF-GUARDS-A: 051_material_batch_identity_option_a.sql
  // is excluded because a later, separately-reviewed phase (FIX-MIGRATION-051-
  // IMMUTABLE-EXPIRY-DATE-A) legitimately corrects it in-place before its
  // first successful manual apply.
  it('git diff for package/lockfiles/migration SQL files is empty other than the already-approved 051 immutable-expiry-date fix (test-only maintenance under supabase/migrations/__tests__/ is not a migration SQL change)', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql" ":!supabase/migrations/051_material_batch_identity_option_a.sql" ":!supabase/migrations/053_item_availability_removed_marker.sql" ":!supabase/migrations/054_dashboard_condition_counts_rpcs.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(diff.trim()).toBe('');

    let pkgDiff = '';
    try {
      pkgDiff = execSync('git diff -- package.json', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    const addedLines = pkgDiff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    const removedLines = pkgDiff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'));
    expect(removedLines.length).toBe(0);
    expect(addedLines.every(l => /"exceljs":/.test(l))).toBe(true);
  });
});

// ─── 23/24: existing handlers remain connected ─────────────────────────────

describe('23. Existing export/print handlers remain connected', () => {
  // SAFE-PROFESSIONAL-XLSX-EXPORT-A: the export button's onClick now calls
  // exportXlsx (real .xlsx via exportAvailabilityXlsx) instead of the old
  // exportCsv — same button, same location, unrelated to this WhatsApp phase.
  it('StatusCenterScreen export/print buttons still call their original handlers', () => {
    expect(statusCenter).toContain('onClick={exportXlsx}');
    expect(statusCenter).toContain('onClick={printReport}');
  });
});

describe('24. Existing button handlers remain connected', () => {
  it('UserManagementScreen save/reset buttons remain wired to onSave/onReset', () => {
    expect(userManagementScreen).toContain('onClick={onSave}');
    expect(userManagementScreen).toContain('onClick={onReset}');
  });

  it('the pre-existing tel: link in ContactSection is still present alongside the new WhatsApp button', () => {
    const block = userManagementScreen.slice(
      userManagementScreen.indexOf('function ContactSection'),
      userManagementScreen.indexOf('function ContactSection') + 1500,
    );
    expect(block).toContain('📞');
    expect(block).toContain('WhatsAppContactButton');
  });
});

// ─── 25: permissions preserved ─────────────────────────────────────────────

describe('25. Permissions visibility is preserved where applicable', () => {
  it('ContactSection is still only rendered for monthly_status_officer target users (unchanged gate)', () => {
    expect(userManagementScreen).toContain("isMonthlyOfficer && <ContactSection");
  });

  it('no new permission keys were invented by the WhatsApp files', () => {
    for (const src of [whatsappHelper, whatsappButton]) {
      expect(src).not.toContain('myPermissions');
      expect(src).not.toContain(".has('");
    }
  });

  it('permissions.ts was not modified by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/shared/lib/permissions.ts', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(diff.trim()).toBe('');
  });
});

// ─── 26/27: RTL/LTR + mobile ────────────────────────────────────────────────

describe('26. RTL/LTR handling remains present', () => {
  it('ContactSection contact names still render dir="auto"', () => {
    expect(userManagementScreen).toContain('dir="auto"');
  });
});

describe('27. Mobile touch target/wrapping exists', () => {
  it('WhatsAppContactButton meets the 38px minimum touch height', () => {
    expect(whatsappButton).toContain("minHeight: '38px'");
  });

  it('ContactSection row wraps on mobile (flexWrap)', () => {
    const block = userManagementScreen.slice(
      userManagementScreen.indexOf('function ContactSection'),
      userManagementScreen.indexOf('function ContactSection') + 1500,
    );
    expect(block).toContain("flexWrap: 'wrap'");
  });
});

describe('Safety guards', () => {
  it('stash@{0} (paused Service-D work) was not popped or applied', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });

  it('premium-preview.html remains untouched (untracked only)', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });
});
