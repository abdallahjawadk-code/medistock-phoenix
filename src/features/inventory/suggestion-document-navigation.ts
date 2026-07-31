import type {
  InventoryRouteKind,
  InventorySuggestionDocumentKind,
} from './inventory-intelligence.service';

export interface SuggestionDocumentTarget {
  routeKind: InventoryRouteKind;
  documentKind: InventorySuggestionDocumentKind;
  documentId: string;
  sourceScopeId: string;
  targetScopeId: string;
}

export function suggestionDocumentScreen(target: SuggestionDocumentTarget): number {
  switch (target.documentKind) {
    case 'warehouse_transfer_request':
      return 17;
    case 'warehouse_dispatch':
      return 3;
    case 'outlet_return_request':
      return 18;
  }
}
