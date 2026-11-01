import assert from 'node:assert/strict';

/** Test native scrolling only after earlier focus/key scrolling has settled. */
export async function verifyNativeHorizontalScroll(region) {
  await region.focus();
  const before = await region.evaluate(async el => {
    let previous = el.scrollLeft, still = 0, settled = false;
    for (let frame = 0; frame < 90; frame += 1) {
      await new Promise(requestAnimationFrame);
      const current = el.scrollLeft; still = current === previous ? still + 1 : 0; previous = current;
      if (still >= 5) { settled = true; break; }
    }
    return { settled, left: el.scrollLeft, range: el.scrollWidth - el.clientWidth,
      direction: getComputedStyle(el).direction, focused: el === document.activeElement };
  });
  assert(before.settled && before.focused, 'Native scroll region must settle with keyboard focus');
  if (before.range <= 1) return { ...before, required: false, moved: false };
  const forward = Math.abs(before.left) < before.range / 2;
  const key = (before.direction === 'rtl') === forward ? 'ArrowLeft' : 'ArrowRight';
  await region.press(key, { delay: 100 });
  const moved = await region.evaluate(async (el, initial) => {
    for (let frame = 0; frame < 90; frame += 1) {
      if (Math.abs(el.scrollLeft - initial) > 1) return true;
      await new Promise(requestAnimationFrame);
    }
    return false;
  }, before.left);
  assert(moved, 'A native arrow key must move the focused horizontal region');
  return { ...before, required: true, moved, key };
}
