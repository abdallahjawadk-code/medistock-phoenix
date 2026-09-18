/**
 * E1 — sheet tabs of the read-only original-workbook viewer.
 *
 * Every sheet the parser reported is listed, in the workbook's own order.
 * A hidden or very-hidden sheet is NOT dropped and NOT dressed up as visible:
 * its tab carries an explicit label (and a dashed outline, so the state never
 * rests on colour alone). Choosing a tab only changes what is displayed — the
 * workbook's own visibility is never altered, and nothing is re-parsed.
 *
 * Keyboard: the WAI-ARIA tabs pattern — one tab stop, arrows move between
 * tabs in their visual order (so the reading direction is respected), Home
 * and End jump to the first and last sheet.
 */
import { useRef, type KeyboardEvent } from 'react';
import { t, type Lang } from '@/shared/i18n/strings';
import type { SheetEvidence } from '../import/contract.ts';

interface Props {
  lang: Lang;
  sheets: SheetEvidence[];
  activeIndex: number;
  onSelect: (index: number) => void;
  tabId: (index: number) => string;
  panelId: string;
}

export function ExcelSheetTabs({ lang, sheets, activeIndex, onSelect, tabId, panelId }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  function focusTab(index: number) {
    onSelect(index);
    const button = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index];
    button?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const last = sheets.length - 1;
    const rtl = listRef.current?.closest('[dir]')?.getAttribute('dir') === 'rtl';
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const backward = rtl ? 'ArrowRight' : 'ArrowLeft';
    let next: number | null = null;
    if (event.key === forward) next = activeIndex >= last ? 0 : activeIndex + 1;
    else if (event.key === backward) next = activeIndex <= 0 ? last : activeIndex - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    if (next === null) return;
    event.preventDefault();
    focusTab(next);
  }

  return (
    <div
      ref={listRef}
      className="cn2b-xl-tabs"
      role="tablist"
      aria-label={t('cn2b_xl_sheets', lang)}
      data-testid="cn2b-xl-tabs"
      onKeyDown={onKeyDown}
    >
      {sheets.map((sheet, index) => {
        const active = index === activeIndex;
        return (
          <button
            key={`${sheet.index}:${sheet.name}`}
            type="button"
            role="tab"
            id={tabId(index)}
            className="cn2b-xl-tab"
            aria-selected={active}
            aria-controls={panelId}
            tabIndex={active ? 0 : -1}
            data-visibility={sheet.hidden}
            data-sheet-index={sheet.index}
            onClick={() => onSelect(index)}
          >
            <bdi className="cn2b-xl-tab__name">{sheet.name}</bdi>
            {sheet.hidden !== 'visible' && (
              <span className="cn2b-xl-tab__hidden">
                {t(sheet.hidden === 'very_hidden' ? 'cn2b_xl_sheet_very_hidden' : 'cn2b_xl_sheet_hidden', lang)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
