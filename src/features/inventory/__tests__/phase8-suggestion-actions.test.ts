import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { T } from '@/shared/i18n/strings';

const root = join(__dirname, '../../../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const panel = read('src/features/inventory/InventoryIntelligencePanel.tsx');
const service = read('src/features/inventory/inventory-intelligence.service.ts');
const app = read('src/app/AuthenticatedApp.tsx');
const reports = read('src/features/reports/DecisionIntelligenceReportsScreen.tsx');
const center = read('src/features/inventory/InventoryCenterScreen.tsx');
const dispatch = read('src/features/outlet/OutletDispatchOperations.tsx');
const outlet = read('src/features/outlet/OutletOperationsScreen.tsx');
const network = read('src/features/network/NetworkManagementScreen.tsx');
const supply = read('src/features/network/DirectSupplyOperations.tsx');

describe('Phase 8 server-backed suggestion actions', () => {
  it('loads one bounded action RPC per visible page and fails closed on missing rows', () => {
    expect(service).toContain("'phoenix_get_inventory_suggestion_actions'");
    expect(service).toMatch(/p_suggestion_ids:\s*rows\.map\(r => r\.id\)/);
    expect(service).toMatch(/const actions = new Map/);
    expect(service).toMatch(/return action \? \[mapSuggestion\(r, action\)\] : \[\]/);
    expect(service).not.toMatch(/draft_warehouse_transfer_request_id.*\.select/s);
  });

  it('uses only the server decision for create, reject and open', () => {
    expect(panel).toContain('action.allowedActions.createDraft');
    expect(panel).toContain('action.allowedActions.reject');
    expect(panel).toContain('action.allowedActions.openDocument');
    expect(panel).not.toContain('myPermissions.has(PK.actOnSuggestions)');
    expect(panel).not.toMatch(/canAct && s\.status === 'open'/);
    expect(panel).not.toContain('isSuggestionStale');
  });

  it('renders truthful terminal, stale and unavailable-document states', () => {
    expect(panel).toContain("action.freshnessState === 'stale'");
    expect(panel).toContain('inv_suggestion_rejected_badge');
    expect(panel).toContain('inv_suggestion_expired_badge');
    expect(panel).toContain('inv_draft_link_missing');
    expect(panel).toContain('inv_draft_unavailable');
  });

  it('provides bilingual accessible create/open actions', () => {
    for (const key of [
      'inv_draft_open_action',
      'inv_draft_link_missing',
      'inv_draft_unavailable',
      'inv_suggestion_rejected_badge',
      'inv_suggestion_expired_badge',
    ]) {
      expect(T[key].ar.trim()).not.toBe('');
      expect(T[key].en.trim()).not.toBe('');
    }
    expect(panel).toMatch(/aria-label=\{`\$\{t\('inv_draft_create_action'/);
    expect(panel).toMatch(/aria-label=\{`\$\{t\('inv_draft_open_action'/);
    expect(panel).toMatch(/flexWrap: 'wrap'/);
  });
});

describe('Phase 8 open-document wiring reuses the three current pages', () => {
  it('carries a server-returned target through the authenticated shell', () => {
    expect(reports).toContain('onOpenDocument={onOpenSuggestionDocument}');
    expect(app).toContain('suggestionDocumentScreen(target)');
    expect(app).toContain('initialSuggestionDocument={navigation?.suggestionDocument}');
  });

  it('opens a central transfer request in the existing supply detail', () => {
    expect(network).toContain("documentKind === 'warehouse_transfer_request'");
    expect(network).toContain('initialTransferRequestId=');
    expect(supply).toContain('initialTransferRequestId ?? null');
  });

  it('opens a warehouse dispatch in the existing dispatch row', () => {
    expect(center).toContain("documentKind === 'warehouse_dispatch'");
    expect(center).toContain('initialDispatchId=');
    expect(dispatch).toContain('initiallyOpen={d.id === initialDispatchId}');
  });

  it('opens an outlet return in the existing return-request surface', () => {
    expect(outlet).toContain("documentKind === 'outlet_return_request'");
    expect(outlet).toContain('initialRequestId=');
    expect(outlet).toContain('initialRequestId ?? null');
    expect(outlet).toContain('<InventoryIntelligencePanel onOpenDocument={onOpenSuggestionDocument} />');
  });
});
