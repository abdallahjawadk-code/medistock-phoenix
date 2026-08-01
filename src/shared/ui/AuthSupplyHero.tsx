import desktop960 from '@/assets/auth-welcome/supply-desktop-960.webp';
import desktop1280 from '@/assets/auth-welcome/supply-desktop-1280.webp';
import desktop1536 from '@/assets/auth-welcome/supply-desktop-1536.webp';
import mobile480 from '@/assets/auth-welcome/supply-mobile-480.webp';
import mobile720 from '@/assets/auth-welcome/supply-mobile-720.webp';
import mobile940 from '@/assets/auth-welcome/supply-mobile-940.webp';

interface Props {
  className?: string;
  /** Set on the Login hero only — it is that screen's LCP element. */
  priority?: boolean;
}

/** Intrinsic sizes of the two masters, used for aspect-ratio/CLS control. */
const DESKTOP_W = 1536;
const DESKTOP_H = 961;
const MOBILE_W = 940;
const MOBILE_H = 1670;

/**
 * A7.2.3 — the production pharmaceutical-supply hero.
 *
 * TRUE ART DIRECTION, not one image reflowed: the landscape master is a
 * desk-width dispensing hall; the portrait master is a separately composed
 * phone view of the same environment. The <source media> query picks ONE of
 * them, so a phone never downloads the desktop master and a desktop never
 * downloads the portrait one — that switch happens before any byte is
 * fetched, which is why this is a <picture> and not a CSS background.
 *
 * The breakpoint is 900px to match the Login shell's own desktop/mobile
 * switch in phase-a-auth.css, so the art direction and the layout always
 * change on the same line.
 *
 * All six variants are local, build-hashed assets imported through Vite —
 * no external URL, no CDN, no runtime fetch, no base64. Text, branding and
 * headings are never baked into the artwork; they stay live React nodes
 * over it.
 *
 * Decorative (aria-hidden, empty alt): the accessible name for this region
 * lives on the caller's own landmark/heading.
 */
export function AuthSupplyHero({ className = '', priority = false }: Props) {
  return (
    <picture className={`auth-supply-hero ${className}`.trim()}>
      <source
        media="(max-width: 900px)"
        type="image/webp"
        srcSet={`${mobile480} 480w, ${mobile720} 720w, ${mobile940} 940w`}
        sizes="100vw"
        width={MOBILE_W}
        height={MOBILE_H}
      />
      <source
        type="image/webp"
        srcSet={`${desktop960} 960w, ${desktop1280} 1280w, ${desktop1536} 1536w`}
        sizes="(max-width: 1100px) 60vw, 65vw"
        width={DESKTOP_W}
        height={DESKTOP_H}
      />
      <img
        className="auth-supply-hero__img"
        src={desktop1280}
        alt=""
        aria-hidden="true"
        width={DESKTOP_W}
        height={DESKTOP_H}
        decoding="async"
        loading="eager"
        {...(priority ? { fetchpriority: 'high' } : {})}
        draggable={false}
      />
    </picture>
  );
}
