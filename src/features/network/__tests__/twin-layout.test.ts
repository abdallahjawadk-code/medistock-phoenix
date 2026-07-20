/**
 * TWIN-2D-LAYOUT — focused tests proving the Digital Twin's 2D map layout is
 * deterministic and collision-free, verified against a DENSE representative
 * fixture (so density, not lucky live-data spread, is what avoids overlap).
 * Run: npm test -- --run
 */
import { describe, it, expect } from 'vitest';
import { computeTwin2dLayout, type TwinLayoutInput } from '../twinLayout';

// Dense, representative supply network: 1 central, 4 institution stores,
// 8 outlets — deliberately more than the live sample, and clustered ids.
const DENSE: TwinLayoutInput[] = [
  { id: 'c1', kind: 'central' },
  { id: 'i1', kind: 'institution' },
  { id: 'i2', kind: 'institution' },
  { id: 'i3', kind: 'institution' },
  { id: 'i4', kind: 'institution' },
  { id: 'o1', kind: 'outlet' }, { id: 'o2', kind: 'outlet' },
  { id: 'o3', kind: 'outlet' }, { id: 'o4', kind: 'outlet' },
  { id: 'o5', kind: 'outlet' }, { id: 'o6', kind: 'outlet' },
  { id: 'o7', kind: 'outlet' }, { id: 'o8', kind: 'outlet' },
];

// Largest node radius drawn on the map is 15 (central); a selected node draws at
// r+3 = 18. Two nodes are "overlapping" if their centres are closer than the sum
// of their drawn radii. Use a conservative safe distance.
const MAX_RADIUS = 18;
const SAFE_DISTANCE = MAX_RADIUS * 2; // 36px centre-to-centre

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe('computeTwin2dLayout: no node overlaps even when dense', () => {
  const { positions } = computeTwin2dLayout(DENSE);
  const pts = DENSE.map(n => positions.get(n.id)!);

  it('places every node', () => {
    expect(pts.every(Boolean)).toBe(true);
    expect(positions.size).toBe(DENSE.length);
  });

  it('keeps every pair of nodes at least a node-diameter apart', () => {
    let minPair = Infinity;
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        minPair = Math.min(minPair, dist(pts[i], pts[j]));
      }
    }
    expect(minPair).toBeGreaterThan(SAFE_DISTANCE);
  });

  it('separates the three tiers vertically (central above institution above outlet)', () => {
    const cy = positions.get('c1')!.y;
    const iy = positions.get('i1')!.y;
    const oy = positions.get('o1')!.y;
    expect(cy).toBeLessThan(iy);
    expect(iy).toBeLessThan(oy);
  });

  it('spreads a tier evenly across the width (no two share an x)', () => {
    const outletXs = DENSE.filter(n => n.kind === 'outlet').map(n => positions.get(n.id)!.x);
    expect(new Set(outletXs).size).toBe(outletXs.length);
  });

  it('alternates label lane within a tier so labels do not crowd one line', () => {
    const outletLanes = DENSE
      .filter(n => n.kind === 'outlet')
      .map(n => positions.get(n.id)!.labelAbove);
    // Adjacent outlets must not both sit in the same label lane.
    for (let i = 1; i < outletLanes.length; i += 1) {
      expect(outletLanes[i]).not.toBe(outletLanes[i - 1]);
    }
  });
});

describe('computeTwin2dLayout: fully deterministic', () => {
  it('is stable across calls and independent of input ordering', () => {
    const a = computeTwin2dLayout(DENSE);
    const shuffled = [...DENSE].reverse();
    const b = computeTwin2dLayout(shuffled);
    for (const node of DENSE) {
      expect(b.positions.get(node.id)).toEqual(a.positions.get(node.id));
    }
  });
});
