import type { PhoenixIconName } from './PhoenixIcon';

/* ─── Emoji → SVG icon resolver ────────────────────────────────────────────────
   Several primitives (metric cards, empty states, nav grids) historically took a
   raw emoji `icon` string. This maps every emoji the product uses to a glyph in
   the deterministic PhoenixIcon SVG family, so the whole app renders ONE icon
   language — professional, monochrome, theme-aware, accessible — instead of the
   OS's multicolour emoji font. Unmapped keys fall back to a neutral SVG, never a
   raw emoji. Variation-selector (️, U+FE0F) is stripped so "⚠️" and "⚠" match. */

const MAP: Record<string, PhoenixIconName> = {
  '🏥': 'hospital',
  '🏛': 'institutions',
  '🏢': 'warehouse',
  '🏬': 'warehouse',
  '🏭': 'warehouse',
  '📦': 'package',
  '📍': 'pin',
  '🗺': 'network',
  '🧩': 'scope',
  '🧭': 'scope',
  '🔀': 'route',
  '📱': 'mobile',
  '📞': 'phone',
  '💊': 'medical',
  '🩺': 'medical',
  '⚠': 'warning',
  '❌': 'close',
  '🚫': 'ban',
  '🔒': 'lock',
  '🔐': 'lock',
  '🔑': 'key',
  '🔔': 'alerts',
  '🔕': 'bell-off',
  '🔴': 'warning',
  '🟢': 'check',
  '✅': 'check',
  '✔': 'check',
  '♻': 'recycle',
  '🔁': 'refresh',
  '🔄': 'refresh',
  '🔍': 'search',
  '🔎': 'search',
  '👥': 'users',
  '👤': 'account',
  '✏': 'editor',
  '📝': 'editor',
  '📈': 'reports',
  '📊': 'reports',
  '📋': 'status',
  '📄': 'file',
  '📁': 'file',
  '🖨': 'print',
  '⏱': 'clock',
  '⏲': 'clock',
  '⏳': 'clock',
  '🕐': 'clock',
  '🕒': 'clock',
  '🕘': 'clock',
  '⭐': 'star',
  '★': 'star',
  '👁': 'eye',
  '⬇': 'download',
  '🔗': 'link',
  '⚙': 'settings',
  '🔥': 'fire',
  '⚡': 'bolt',
  '🧠': 'brain',
  '📷': 'camera',
  '🌐': 'globe',
  '💾': 'save',
  '📵': 'ban',
};

/** Strip emoji variation selectors (U+FE0E/FE0F) and ZWJ so lookups are stable. */
function normalizeEmoji(key: string): string {
  return key.replace(/[︀-️‍]/g, '').trim();
}

/**
 * Resolve an emoji (or already-normalized key) to a PhoenixIcon name.
 * Falls back to a neutral SVG so nothing ever renders a raw emoji glyph.
 */
export function resolveEmojiIcon(
  icon: string | undefined,
  fallback: PhoenixIconName = 'status',
): PhoenixIconName {
  if (!icon) return fallback;
  // A canonical lowercase-ascii PhoenixIconName is passed straight through, so
  // callers can (and should) use clean icon names; legacy emoji keys still map.
  if (/^[a-z]+$/.test(icon)) return icon as PhoenixIconName;
  return MAP[normalizeEmoji(icon)] ?? fallback;
}
