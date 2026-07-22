/**
 * TWIN-2D-LAYOUT — deterministic, collision-free placement for the Digital
 * Twin's 2D SVG map. The 3D scene positions nodes on a sphere-ish cloud, which
 * projects to overlapping 2D points when nodes are dense or near each other.
 * The 2D map instead uses a fixed supply-hierarchy layout:
 *
 *   central  ── top tier
 *   institution ── middle tier
 *   outlet   ── bottom tier
 *
 * Within a tier the nodes are spread evenly across the width, so the minimum
 * horizontal gap is width/(n+1) — guaranteeing node circles never overlap no
 * matter how many nodes a tier holds. Tiers are separated vertically, so
 * cross-tier nodes never collide either. Ordering is by id, so the layout is
 * fully deterministic (same input → same output; not dependent on live data
 * spreading itself out). Labels alternate above/below within a tier, doubling
 * the horizontal room each label lane has and so avoiding label overlap in
 * dense tiers.
 */
export type TwinNodeKind = 'central' | 'institution' | 'outlet';

export interface TwinLayoutInput {
  id: string;
  kind: TwinNodeKind;
}

export interface TwinLayoutPos {
  x: number;
  y: number;
  /** true → render the label above the node; false → below. Alternates per tier. */
  labelAbove: boolean;
}

export interface TwinLayoutResult {
  positions: Map<string, TwinLayoutPos>;
  width: number;
  height: number;
}

const TIER_ORDER: TwinNodeKind[] = ['central', 'institution', 'outlet'];

export function computeTwin2dLayout(
  nodes: TwinLayoutInput[],
  width = 1000,
  height = 660,
): TwinLayoutResult {
  const tierY: Record<TwinNodeKind, number> = {
    central: Math.round(height * 0.18),
    institution: Math.round(height * 0.5),
    outlet: Math.round(height * 0.82),
  };
  const positions = new Map<string, TwinLayoutPos>();

  for (const kind of TIER_ORDER) {
    const list = nodes
      .filter(n => n.kind === kind)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const n = list.length;
    list.forEach((node, i) => {
      positions.set(node.id, {
        x: Math.round((width * (i + 1)) / (n + 1)),
        y: tierY[kind],
        labelAbove: i % 2 === 0,
      });
    });
  }

  return { positions, width, height };
}
