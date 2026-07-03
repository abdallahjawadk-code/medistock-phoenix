/**
 * BUGFIX-REPORTS-DATES-PORT-CLEAR-A
 *
 * QrScreen's print flow duplicates the same print-HTML pattern used by
 * StatusCenterScreen/MovementReportSection and had the same two bugs:
 *   1. `window.open()` returning null (popup blocked) was silently
 *      swallowed — the user clicked "Print" and nothing visibly happened.
 *   2. It is `async` and calls `window.open()` AFTER an `await
 *      QRCode.toDataURL(...)` — some browsers (notably Safari) drop the
 *      "triggered by a user gesture" flag across an await, so window.open()
 *      called post-await can be silently blocked even when the click really
 *      did originate the call. Opening the window synchronously first (then
 *      writing content into it once the QR data URL resolves) removes that
 *      risk entirely rather than just reporting it after the fact.
 *   3. Timestamps ("Created:", "Last scan:", "Disabled:", and the print
 *      footer date) were rendered via toLocaleDateString/toLocaleString('ar'-*)
 *      without a dir="ltr" wrapper in three spots, and the print footer date
 *      had no direction override at all — the exact RTL bidi reordering bug
 *      reported elsewhere in the app.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const screen = readSrc('features/qr/QrScreen.tsx');

describe('QrScreen: onPrint opens the window synchronously (no async gap before window.open)', () => {
  it('window.open is called before the QRCode.toDataURL await, not after', () => {
    const fnBody = screen.slice(screen.indexOf('async function onPrint'), screen.indexOf('async function onRevoke'));
    const openIdx = fnBody.indexOf("window.open('', '_blank'");
    const awaitIdx = fnBody.indexOf('await QRCode.toDataURL');
    expect(openIdx).toBeGreaterThan(-1);
    expect(awaitIdx).toBeGreaterThan(-1);
    expect(openIdx).toBeLessThan(awaitIdx);
  });

  it('shows print_popup_blocked instead of silently returning when window.open fails', () => {
    const fnBody = screen.slice(screen.indexOf('async function onPrint'), screen.indexOf('async function onRevoke'));
    expect(fnBody).toContain("showToast(t('print_popup_blocked', lang))");
    expect(fnBody).not.toMatch(/if \(!win\) return;/);
  });

  it('closes the already-opened window if QR generation fails after it was opened (no dangling blank popup)', () => {
    const fnBody = screen.slice(screen.indexOf('async function onPrint'), screen.indexOf('async function onRevoke'));
    const catchBlock = fnBody.slice(fnBody.indexOf('} catch {'));
    expect(catchBlock).toContain('win.close();');
    expect(catchBlock).toContain("showToast(t('qr_display_error', lang))");
  });
});

describe('QrScreen: stable, LTR-safe date rendering', () => {
  it('fmtDate/fmtDatetime delegate to the shared stable formatters', () => {
    expect(screen).toContain('formatStableDate(iso, lang)');
    expect(screen).toContain('formatStableDateTime(iso, lang)');
    expect(screen).not.toMatch(/toLocaleDateString\(lang === 'ar' \? 'ar-IQ'/);
    expect(screen).not.toMatch(/toLocaleString\(lang === 'ar' \? 'ar-IQ'/);
  });

  it('"Last scan" value is wrapped in dir="ltr"', () => {
    expect(screen).toMatch(/<span style=\{\{ fontWeight: 600 \}\} dir="ltr">\{fmtDatetime/);
  });

  it('"Created" value is wrapped in dir="ltr"', () => {
    expect(screen).toMatch(/Created: '\}<span dir="ltr">\{fmtDate\(row\.created_at/);
  });

  it('"Disabled" value is wrapped in dir="ltr"', () => {
    expect(screen).toMatch(/Disabled: '\}<span dir="ltr">\{fmtDate\(row\.disabled_at/);
  });

  it('the print footer date paragraph carries dir="ltr" (previously unwrapped)', () => {
    const fnBody = screen.slice(screen.indexOf('async function onPrint'), screen.indexOf('async function onRevoke'));
    expect(fnBody).toContain('<p class="date" dir="ltr">${esc(generated)}</p>');
  });

  it('the print footer date value comes from formatStableDate, not a raw locale call', () => {
    const fnBody = screen.slice(screen.indexOf('async function onPrint'), screen.indexOf('async function onRevoke'));
    expect(fnBody).toContain('const generated = formatStableDate(new Date(), lang);');
  });
});

describe('Guards: no unrelated changes', () => {
  it('no inter_org_exchange reference was added', () => {
    expect(screen).not.toMatch(/inter_org_exchange/i);
  });

  it('no service_role/auth.admin usage', () => {
    expect(screen).not.toMatch(/service_role|auth\.admin/i);
  });
});
