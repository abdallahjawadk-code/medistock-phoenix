import type { KeyboardEvent } from 'react';

/** Manual tabs: arrows move focus; only the existing button activation changes
 * the content, so traversing the strip cannot unmount an unfinished form. */
export function handleInventoryTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const list = event.currentTarget;
  const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[role="tab"]') : null;
  if (!target || target.parentElement !== list) return;
  const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>(':scope > button[role="tab"]'))
    .filter(button => !button.disabled && button.getAttribute('aria-disabled') !== 'true' && !button.hidden);
  const current = tabs.indexOf(target); if (current < 0 || tabs.length < 1) return;
  const rtl = list.closest('[dir]')?.getAttribute('dir') === 'rtl';
  let next: number;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  else if (event.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) next = (current + 1) % tabs.length;
  else if (event.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) next = (current - 1 + tabs.length) % tabs.length;
  else return;
  event.preventDefault(); tabs[next].focus();
}
