import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FEATURE = join(__dirname, '..');
const read = (path: string) => readFileSync(join(FEATURE, path), 'utf8');
const stage = read('NetworkTopologyStage.tsx');
const scene = read('NetworkTwin3DScene.tsx');
const screen = read('NetworkManagementScreen.tsx');
const css = read('../../shared/lib/phoenix-nexus.css');

describe('Cinematic operational digital twin', () => {
  it('restores adjacent, accessible 3D and 2D tabs', () => {
    expect(stage).toContain("type ViewMode = 'three-d' | 'two-d'");
    expect(stage).toContain("'مجسم 3D'");
    expect(stage).toContain("'خريطة 2D'");
    expect(stage).toContain('role="tablist"');
    expect(stage).toContain('role="tab"');
    expect(stage).toContain("aria-selected={viewMode === 'three-d'}");
    expect(stage).toContain("aria-selected={viewMode === 'two-d'}");
  });

  it('uses the clean Babil terrain plate with live overlays, not a baked UI screenshot', () => {
    expect(stage).toContain('/assets/phoenix/runtime/phoenix-babil-terrain.avif');
    expect(stage).toContain('/assets/phoenix/runtime/phoenix-babil-terrain.webp');
    expect(stage).toContain('<NodeLabel');
    expect(stage).toContain('<SelectionPanel');
    expect(stage).toContain('node.alert?.severity');
    expect(css).toContain('.nexus-twin__terrain');
    expect(css).toContain('.nexus-twin__selection-panel');
  });

  it('renders real React Three Fiber geometry, lighting, routes, and a moving supply vehicle', () => {
    expect(scene).toContain("from '@react-three/fiber'");
    expect(scene).toContain('<Canvas');
    expect(scene).toContain('<boxGeometry');
    expect(scene).toContain('<cylinderGeometry');
    expect(scene).toContain('<tubeGeometry');
    expect(scene).toContain('<directionalLight');
    expect(scene).toContain('function SupplyVehicle');
    expect(scene).toContain('curve.getPointAt(progress)');
    expect(scene).toContain('ACESFilmicToneMapping');
  });

  it('keeps a cinematic safe map and functional 2D view when WebGL is unavailable', () => {
    expect(stage).toContain("data-webgl={real3D ? 'on' : 'fallback'}");
    expect(stage).toContain('الخريطة السينمائية الآمنة فعّالة');
    expect(stage).toContain('<TwoDTopology');
    expect(scene).toContain('webglcontextlost');
  });

  it('derives direct central → institution → outlet links without consulting legacy supply routes', () => {
    expect(stage).toContain("kind: 'direct'");
    expect(stage).toContain("kind: 'outlet'");
    expect(stage).not.toContain('SupplyRoute');
    expect(stage).not.toContain('getSupplyRoutes');
    expect(screen).not.toContain('getSupplyRoutes()');
    expect(screen).toContain('const topologyWarehouses = warehouses.data ?? []');
  });

  it('does not add data writes or backend calls to the visualization', () => {
    for (const source of [stage, scene]) {
      expect(source).not.toContain('supabaseClient');
      expect(source).not.toMatch(/supabase\s*\./);
      expect(source).not.toMatch(/\.(insert|update|delete|upsert|rpc)\s*\(/);
    }
  });
});
