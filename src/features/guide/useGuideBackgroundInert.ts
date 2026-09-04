import { useEffect } from 'react';

/**
 * INTERACTIVE-GUIDE-IG1 — make everything behind the guide genuinely
 * non-interactive, and put it back exactly as it was on close.
 *
 * The blocking layer already stops mouse and touch. This closes the other two
 * doors: keyboard focus and assistive-technology traversal. Without it, Tab
 * would still walk into the operational control the guide is pointing at and
 * Enter would activate it — the exact failure the safety review calls out
 * (AD-04), and one a visually correct overlay hides completely.
 *
 * Same mechanism the mobile drawer already uses for its own modal state, so
 * the shell has one answer to "background is inert while an overlay is open"
 * rather than two that can drift apart. Prior `inert`/`aria-hidden` values are
 * recorded and restored, so an element another overlay had already marked is
 * not un-marked underneath it.
 */
export function useGuideBackgroundInert(container: HTMLElement | null): void {
  useEffect(() => {
    if (!container) return;
    const parent = container.parentElement;
    if (!parent) return;

    const siblings = Array.from(parent.children)
      .filter((node): node is HTMLElement => node instanceof HTMLElement && node !== container);
    const previous = siblings.map(node => ({
      node,
      inert: node.hasAttribute('inert'),
      ariaHidden: node.getAttribute('aria-hidden'),
    }));

    for (const { node } of previous) {
      node.setAttribute('inert', '');
      node.setAttribute('aria-hidden', 'true');
    }

    return () => {
      for (const item of previous) {
        if (!item.inert) item.node.removeAttribute('inert');
        if (item.ariaHidden === null) item.node.removeAttribute('aria-hidden');
        else item.node.setAttribute('aria-hidden', item.ariaHidden);
      }
    };
  }, [container]);
}
