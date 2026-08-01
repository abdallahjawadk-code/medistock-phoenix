interface Props {
  className?: string;
}

/**
 * A7.2.2 — production institutional pharmaceutical-supply scene.
 *
 * The hero illustration for Login and Welcome. This REPLACES the earlier
 * flat cube-and-icon diagram (InstitutionalSupplyMotif), which read as a
 * teaching diagram rather than the premium institutional environment the
 * reference board requires.
 *
 * It is an original, hand-authored isometric ENVIRONMENT — not a set of
 * icons on a background. It contains, as the visual contract demands:
 *   • a pharmacy-department warehouse with a real loading dock (roller
 *     doors, dock apron, pallets, roof plant units);
 *   • a hospital block with a glazed window grid, entrance canopy and a
 *     medical cross sign;
 *   • a dispensing pharmacy with an awning, storefront glazing and sign;
 *   • a central distribution hub — a lit platform carrying the medicine
 *     consignment;
 *   • a delivery truck on the service road;
 *   • roads//connection lines tying the four sites into one network;
 *   • a ground plane with isometric perspective and a horizon wash;
 *   • a single consistent light direction with cast shadows for every mass;
 *   • several depth levels (ground → roads → back row → hub → front row).
 *
 * Technique: true 2:1 isometric projection. Every solid is built from a
 * top rhombus plus a left and right face, each face a fixed opacity step of
 * ONE token colour, so the whole scene re-themes for light/dark purely from
 * the surrounding daylight token scope (see
 * phase-a-auth-welcome-signature.css) with no per-face colour authoring and
 * no second palette to keep in sync.
 *
 * 100% inline SVG: no raster asset, no external URL, no CDN, no runtime
 * fetch, no new dependency, and no text baked into the artwork — every
 * headline/label on these screens stays live, translatable React text.
 *
 * Purely decorative (aria-hidden); the accessible name lives on the
 * caller's own heading, exactly as the previous hero art did.
 */
export function PharmaceuticalSupplyScene({ className = '' }: Props) {
  return (
    <svg
      className={`pharma-scene ${className}`.trim()}
      viewBox="0 0 1200 800"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* Ground plane — lit from upper-left, falling off to the rear */}
        <linearGradient id="pss-ground" x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0%" stopColor="var(--teal)" stopOpacity=".07" />
          <stop offset="100%" stopColor="var(--teal)" stopOpacity=".16" />
        </linearGradient>
        {/* Warm key light pooling around the consignment hub */}
        <radialGradient id="pss-hub-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--phoenix-gold)" stopOpacity=".55" />
          <stop offset="60%" stopColor="var(--phoenix-gold)" stopOpacity=".14" />
          <stop offset="100%" stopColor="var(--phoenix-gold)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="pss-beam" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--phoenix-gold)" stopOpacity=".30" />
          <stop offset="100%" stopColor="var(--phoenix-gold)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* ── L0 · atmosphere ─────────────────────────────────────────────
          Deliberately NO full-bleed background rect: a rect spanning the
          viewBox draws a hard-edged lighter rectangle wherever the host
          panel is darker than it (clearly visible in dark theme), which
          made the scene read as a pasted-in box rather than part of the
          panel. The host supplies the field; the scene supplies only the
          world, so it sits on any background. ───────────────────────── */}

      {/* ── L1 · ground plane + isometric survey grid ───────────────────── */}
      <g className="pharma-scene__ground">
        <polygon points="600,90 1190,385 600,680 10,385" fill="url(#pss-ground)" />
        <g className="pharma-scene__grid">
          <path d="M305,237 L895,532" /><path d="M453,311 L1043,606" />
          <path d="M157,163 L747,458" /><path d="M895,237 L305,532" />
          <path d="M747,163 L157,458" /><path d="M1043,311 L453,606" />
        </g>
      </g>

      {/* ── L2 · service roads knitting the four sites together ─────────── */}
      <g className="pharma-scene__road">
        <polygon points="430,322 548,381 548,411 430,352" />
        <polygon points="806,318 712,377 712,407 806,348" />
        <polygon points="566,470 436,542 436,572 566,500" />
        <polygon points="646,494 1064,520 1064,556 646,530" />
      </g>
      <g className="pharma-scene__road-mark">
        <path d="M446,337 L536,382" /><path d="M792,333 L724,376" />
        <path d="M556,486 L452,543" /><path d="M676,514 L1034,536" />
      </g>

      {/* ── L3 · BACK ROW — warehouse (pharmacy-department central store) ── */}
      <g className="pharma-scene__site">
        <ellipse className="pharma-scene__shadow" cx="300" cy="428" rx="172" ry="35" />

        {/* main mass */}
        <polygon className="pharma-scene__face-left"  points="145,275 295,350 295,418 145,343" />
        <polygon className="pharma-scene__face-right" points="295,350 445,275 445,343 295,418" />
        <polygon className="pharma-scene__roof"       points="295,200 445,275 295,350 145,275" />
        {/* roof parapet + plant units */}
        <polygon className="pharma-scene__roof-inset" points="295,213 432,281 295,349 158,281" />
        <polygon className="pharma-scene__face-left"  points="222,250 250,264 250,278 222,264" />
        <polygon className="pharma-scene__face-right" points="250,264 278,250 278,264 250,278" />
        <polygon className="pharma-scene__roof-unit"  points="250,236 278,250 250,264 222,250" />
        <polygon className="pharma-scene__face-left"  points="330,290 358,304 358,316 330,302" />
        <polygon className="pharma-scene__face-right" points="358,304 386,290 386,302 358,316" />
        <polygon className="pharma-scene__roof-unit"  points="358,276 386,290 358,304 330,290" />

        {/* loading dock: apron + three roller doors on the hub-facing wall */}
        <polygon className="pharma-scene__apron" points="295,418 445,343 462,352 312,427" />
        <polygon className="pharma-scene__door" points="313,365 340,351.5 340,395.5 313,409" />
        <polygon className="pharma-scene__door" points="352,345.5 379,332 379,376 352,389.5" />
        <polygon className="pharma-scene__door" points="391,326 418,312.5 418,356.5 391,370" />
        {/* dock banding along the wall head */}
        <polygon className="pharma-scene__band" points="295,350 445,275 445,283 295,358" />

        {/* palletised consignments waiting on the apron */}
        <g className="pharma-scene__crate">
          <polygon className="pharma-scene__face-left"  points="470,368 488,377 488,392 470,383" />
          <polygon className="pharma-scene__face-right" points="488,377 506,368 506,383 488,392" />
          <polygon className="pharma-scene__crate-top"  points="488,359 506,368 488,377 470,368" />
        </g>
        <g className="pharma-scene__crate">
          <polygon className="pharma-scene__face-left"  points="500,388 516,396 516,409 500,401" />
          <polygon className="pharma-scene__face-right" points="516,396 532,388 532,401 516,409" />
          <polygon className="pharma-scene__crate-top"  points="516,380 532,388 516,396 500,388" />
        </g>
      </g>

      {/* ── L3 · BACK ROW — hospital ────────────────────────────────────── */}
      <g className="pharma-scene__site">
        <ellipse className="pharma-scene__shadow" cx="900" cy="444" rx="134" ry="28" />

        <polygon className="pharma-scene__face-left"  points="785,260 900,317 900,435 785,378" />
        <polygon className="pharma-scene__face-right" points="900,317 1015,260 1015,378 900,435" />
        <polygon className="pharma-scene__roof"       points="900,203 1015,260 900,317 785,260" />
        <polygon className="pharma-scene__roof-inset" points="900,214 1004,266 900,318 796,266" />
        {/* rooftop plant */}
        <polygon className="pharma-scene__face-left"  points="872,252 894,263 894,275 872,264" />
        <polygon className="pharma-scene__face-right" points="894,263 916,252 916,264 894,275" />
        <polygon className="pharma-scene__roof-unit"  points="894,241 916,252 894,263 872,252" />

        {/* glazing — three storeys, both visible elevations */}
        <g className="pharma-scene__glass">
          <polygon points="796.5,289.7 817.2,300 817.2,316 796.5,305.7" />
          <polygon points="826.4,304.5 847.1,314.8 847.1,330.8 826.4,320.5" />
          <polygon points="856.3,319.3 877,329.6 877,345.6 856.3,335.3" />
          <polygon points="796.5,319.7 817.2,330 817.2,346 796.5,335.7" />
          <polygon points="826.4,334.5 847.1,344.8 847.1,360.8 826.4,350.5" />
          <polygon points="856.3,349.3 877,359.6 877,375.6 856.3,365.3" />
          <polygon points="796.5,349.7 817.2,360 817.2,376 796.5,365.7" />
          <polygon points="826.4,364.5 847.1,374.8 847.1,390.8 826.4,380.5" />
          <polygon points="856.3,379.3 877,389.6 877,405.6 856.3,395.3" />

          <polygon points="923,335.6 943.7,325.3 943.7,341.3 923,351.6" />
          <polygon points="952.9,320.8 973.6,310.5 973.6,326.5 952.9,336.8" />
          <polygon points="923,365.6 943.7,355.3 943.7,371.3 923,381.6" />
          <polygon points="952.9,350.8 973.6,340.5 973.6,356.5 952.9,366.8" />
          <polygon points="923,395.6 943.7,385.3 943.7,401.3 923,411.6" />
          <polygon points="952.9,380.8 973.6,370.5 973.6,386.5 952.9,396.8" />
        </g>

        {/* medical cross sign, canopy and ambulance bay */}
        <g className="pharma-scene__sign">
          <polygon points="988,283 1000,289 1000,301 988,295" />
          <polygon points="984,291.5 1004,281.5 1004,287.5 984,297.5" />
        </g>
        <polygon className="pharma-scene__canopy" points="900,435 962,404 980,413 918,444" />
        <polygon className="pharma-scene__entrance" points="900,404 928,390 928,420 900,434" />
      </g>

      {/* ── L4 · CENTRAL DISTRIBUTION HUB ───────────────────────────────── */}
      <g className="pharma-scene__hub">
        <ellipse cx="640" cy="430" rx="250" ry="130" fill="url(#pss-hub-glow)" />
        <ellipse className="pharma-scene__shadow" cx="640" cy="500" rx="140" ry="29" />

        {/* lit platform */}
        <polygon className="pharma-scene__face-left"  points="520,415 640,475 640,491 520,431" />
        <polygon className="pharma-scene__face-right" points="640,475 760,415 760,431 640,491" />
        <polygon className="pharma-scene__platform"   points="640,355 760,415 640,475 520,415" />
        <polygon className="pharma-scene__platform-inset" points="640,371 734,418 640,465 546,418" />
        <ellipse className="pharma-scene__orbit" cx="640" cy="415" rx="112" ry="56" />

        {/* light shaft carrying the consignment */}
        <polygon points="594,352 686,352 700,415 580,415" fill="url(#pss-beam)" />

        {/* the medicine consignment itself */}
        <polygon className="pharma-scene__gold-left"  points="594,330 640,353 640,393 594,370" />
        <polygon className="pharma-scene__gold-right" points="640,353 686,330 686,370 640,393" />
        <polygon className="pharma-scene__gold-top"   points="640,307 686,330 640,353 594,330" />
        {/* strapping */}
        <path className="pharma-scene__strap" d="M617,318.5 L663,341.5 M663,318.5 L617,341.5" />
      </g>

      {/* ── L5 · FRONT ROW — dispensing pharmacy ────────────────────────── */}
      <g className="pharma-scene__site">
        <ellipse className="pharma-scene__shadow" cx="335" cy="678" rx="122" ry="25" />

        <polygon className="pharma-scene__face-left"  points="230,560 335,612 335,670 230,618" />
        <polygon className="pharma-scene__face-right" points="335,612 440,560 440,618 335,670" />
        <polygon className="pharma-scene__roof"       points="335,508 440,560 335,612 230,560" />
        <polygon className="pharma-scene__roof-inset" points="335,519 429,566 335,613 241,566" />

        {/* storefront glazing + awning + dispensing sign */}
        <g className="pharma-scene__glass">
          <polygon points="248,578 280,594 280,616 248,600" />
          <polygon points="290,599 322,615 322,637 290,621" />
        </g>
        <polygon className="pharma-scene__awning" points="230,618 335,670 335,682 230,630" />
        <g className="pharma-scene__sign">
          <polygon points="372,589 384,595 384,607 372,601" />
          <polygon points="368,597.5 388,587.5 388,593.5 368,603.5" />
        </g>
        <polygon className="pharma-scene__entrance" points="356,631 380,619 380,645 356,657" />
      </g>

      {/* ── L5 · FRONT ROW — delivery vehicle on the service road ─────────
          A white box body with a teal cab and a gold livery band: the
          cargo volume must stay the lightest mass in the front row so it
          reads as a vehicle against the teal buildings behind it. */}
      <g className="pharma-scene__truck">
        <ellipse className="pharma-scene__shadow" cx="862" cy="630" rx="108" ry="20" />

        {/* cargo body */}
        <polygon className="pharma-scene__body-left"  points="772,545 830,574 830,616 772,587" />
        <polygon className="pharma-scene__body-right" points="830,574 888,545 888,587 830,616" />
        <polygon className="pharma-scene__body-top"   points="830,516 888,545 830,574 772,545" />
        {/* livery band + dispensing cross */}
        <polygon className="pharma-scene__band" points="772,562 830,591 830,599 772,570" />
        <g className="pharma-scene__sign">
          <polygon points="795,556 803,560 803,570 795,566" />
          <polygon points="792,561.5 806,554.5 806,560.5 792,567.5" />
        </g>

        {/* cab — teal, lower and shorter than the body */}
        <polygon className="pharma-scene__face-left"  points="888,569 916,583 916,611 888,597" />
        <polygon className="pharma-scene__face-right" points="916,583 944,569 944,597 916,611" />
        <polygon className="pharma-scene__roof"       points="916,555 944,569 916,583 888,569" />
        <polygon className="pharma-scene__glass-solid" points="916,586 940,574 940,586 916,598" />

        {/* wheels */}
        <ellipse className="pharma-scene__wheel" cx="800" cy="601" rx="10" ry="5.5" />
        <ellipse className="pharma-scene__wheel" cx="858" cy="630" rx="10" ry="5.5" />
        <ellipse className="pharma-scene__wheel" cx="925" cy="612" rx="9" ry="5" />
      </g>

      {/* ── L6 · landscaping — reads as depth, never as clutter ─────────── */}
      <g className="pharma-scene__tree">
        <ellipse className="pharma-scene__shadow" cx="545" cy="292" rx="16" ry="5" />
        <rect className="pharma-scene__trunk" x="542" y="272" width="5" height="20" rx="2" />
        <ellipse className="pharma-scene__canopy-leaf" cx="544.5" cy="266" rx="19" ry="15" />
      </g>
      <g className="pharma-scene__tree">
        <ellipse className="pharma-scene__shadow" cx="1078" cy="452" rx="17" ry="5" />
        <rect className="pharma-scene__trunk" x="1075" y="430" width="5" height="22" rx="2" />
        <ellipse className="pharma-scene__canopy-leaf" cx="1077.5" cy="423" rx="21" ry="16" />
      </g>
      <g className="pharma-scene__tree">
        <ellipse className="pharma-scene__shadow" cx="168" cy="486" rx="15" ry="5" />
        <rect className="pharma-scene__trunk" x="165.5" y="467" width="5" height="19" rx="2" />
        <ellipse className="pharma-scene__canopy-leaf" cx="168" cy="461" rx="18" ry="14" />
      </g>
      <g className="pharma-scene__tree">
        <ellipse className="pharma-scene__shadow" cx="700" cy="604" rx="16" ry="5" />
        <rect className="pharma-scene__trunk" x="697.5" y="583" width="5" height="21" rx="2" />
        <ellipse className="pharma-scene__canopy-leaf" cx="700" cy="576" rx="20" ry="15" />
      </g>
    </svg>
  );
}
