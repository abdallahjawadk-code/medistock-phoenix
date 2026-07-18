import type { GlobalMaterialSearchResult, GlobalMaterialSearchRow, GlobalMaterialSignal } from './global-material-search.service';

type Lang = 'ar' | 'en';

export interface GlobalMaterialExportContext {
  lang: Lang;
  query: string;
  organizations: Array<{ id: string; name: string; nameAr: string }>;
  result: GlobalMaterialSearchResult;
}

const COPY = {
  ar: {
    title: 'تقرير البحث الشامل عن المادة',
    details: 'تفاصيل الأرصدة',
    institutions: 'ملخص المؤسسات',
    definitions: 'التعاريف والسياسة',
    generated: 'تاريخ الإصدار',
    query: 'عبارة البحث',
    orgCount: 'عدد المؤسسات المحددة',
    resultCount: 'عدد النتائج',
    institution: 'المؤسسة',
    locationType: 'نوع الموقع',
    location: 'المذخر / المنفذ',
    scientific: 'الاسم العلمي',
    trade: 'الاسم التجاري',
    national: 'الرمز الوطني',
    concentration: 'التركيز',
    dosage: 'الشكل الصيدلاني',
    unit: 'الوحدة',
    onHand: 'الرصيد الفعلي',
    reserved: 'المحجوز',
    available: 'المتاح',
    batches: 'عدد الدفعات',
    nearestExpiry: 'أقرب صلاحية',
    expiredQty: 'متاح منتهي',
    nearQty: 'متاح قريب النفاذ',
    status: 'الحالة',
    warehouse: 'مذخر',
    outlet: 'منفذ',
    locations: 'عدد المواقع',
    rule: 'القاعدة',
    meaning: 'المعنى',
  },
  en: {
    title: 'Global Material Search Report',
    details: 'Stock Details',
    institutions: 'Institution Summary',
    definitions: 'Definitions & Policy',
    generated: 'Generated at',
    query: 'Search query',
    orgCount: 'Selected institutions',
    resultCount: 'Result rows',
    institution: 'Institution',
    locationType: 'Location type',
    location: 'Warehouse / outlet',
    scientific: 'Scientific name',
    trade: 'Trade name',
    national: 'National code',
    concentration: 'Concentration',
    dosage: 'Dosage form',
    unit: 'Unit',
    onHand: 'On hand',
    reserved: 'Reserved',
    available: 'Available',
    batches: 'Batch count',
    nearestExpiry: 'Nearest expiry',
    expiredQty: 'Expired available',
    nearQty: 'Near-expiry available',
    status: 'Status',
    warehouse: 'Warehouse',
    outlet: 'Outlet',
    locations: 'Locations',
    rule: 'Rule',
    meaning: 'Meaning',
  },
} as const;

const SIGNAL: Record<GlobalMaterialSignal, { ar: string; en: string }> = {
  missing: { ar: 'مفقودة', en: 'Missing' },
  low_stock: { ar: 'شحيحة', en: 'Low stock' },
  surplus: { ar: 'فائضة', en: 'Surplus' },
  near_expiry: { ar: 'قريبة النفاذ', en: 'Near expiry' },
  expired: { ar: 'منتهية الصلاحية', en: 'Expired' },
};

function displayName(row: GlobalMaterialSearchRow, lang: Lang): string {
  return lang === 'ar'
    ? (row.organizationNameAr || row.organizationName)
    : (row.organizationName || row.organizationNameAr);
}

function displayScope(row: GlobalMaterialSearchRow, lang: Lang): string {
  return lang === 'ar'
    ? (row.scopeNameAr || row.scopeName)
    : (row.scopeName || row.scopeNameAr);
}

function statusLabel(row: GlobalMaterialSearchRow, lang: Lang): string {
  if (row.signals.length === 0) return lang === 'ar' ? 'متاحة' : 'Available';
  return row.signals.map(signal => SIGNAL[signal][lang]).join('، ');
}

function sanitizeFilePart(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'material';
}

function styleTitle(row: import('exceljs').Row): void {
  row.height = 30;
  row.font = { bold: true, size: 18, color: { argb: 'FFFFD166' } };
  row.alignment = { horizontal: 'center', vertical: 'middle' };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B1F33' } };
}

function styleHeader(row: import('exceljs').Row): void {
  row.height = 24;
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153B5B' } };
  row.eachCell(cell => {
    cell.border = {
      top: { style: 'thin', color: { argb: 'FF365B78' } },
      left: { style: 'thin', color: { argb: 'FF365B78' } },
      bottom: { style: 'thin', color: { argb: 'FF365B78' } },
      right: { style: 'thin', color: { argb: 'FF365B78' } },
    };
  });
}

function statusFill(row: import('exceljs').Row, signals: GlobalMaterialSignal[]): void {
  if (signals.includes('expired') || signals.includes('missing')) {
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE4E6' } };
  } else if (signals.includes('low_stock') || signals.includes('near_expiry')) {
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4D6' } };
  } else if (signals.includes('surplus')) {
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7F8EF' } };
  }
}

/**
 * Builds and downloads an Excel workbook from the already-returned search
 * result. It performs no extra database query and uploads nothing.
 */
export async function exportGlobalMaterialSearchWorkbook(
  context: GlobalMaterialExportContext,
): Promise<void> {
  const { Workbook } = await import('exceljs');
  const workbook = new Workbook();
  const c = COPY[context.lang];
  const rtl = context.lang === 'ar';

  workbook.creator = 'MediStock Phoenix';
  workbook.company = context.lang === 'ar' ? 'دائرة صحة بابل - قسم الصيدلة' : 'Babylon Health Directorate - Pharmacy Department';
  workbook.subject = c.title;
  workbook.created = new Date();

  const details = workbook.addWorksheet(c.details, {
    views: [{ state: 'frozen', ySplit: 4, rightToLeft: rtl }],
    pageSetup: {
      paperSize: 9,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
  });

  details.mergeCells('A1:Q1');
  details.getCell('A1').value = c.title;
  styleTitle(details.getRow(1));
  details.mergeCells('A2:Q2');
  details.getCell('A2').value = `${c.generated}: ${new Date(context.result.searchedAt).toLocaleString(context.lang === 'ar' ? 'ar-IQ' : 'en-GB')}   |   ${c.query}: ${context.query}   |   ${c.orgCount}: ${context.organizations.length}   |   ${c.resultCount}: ${context.result.totalRows}`;
  details.getCell('A2').alignment = { horizontal: rtl ? 'right' : 'left', vertical: 'middle' };
  details.getCell('A2').font = { italic: true, color: { argb: 'FF51697C' } };

  details.columns = [
    { key: 'institution', width: 28 },
    { key: 'locationType', width: 15 },
    { key: 'location', width: 26 },
    { key: 'scientific', width: 28 },
    { key: 'trade', width: 24 },
    { key: 'national', width: 18 },
    { key: 'concentration', width: 18 },
    { key: 'dosage', width: 20 },
    { key: 'unit', width: 13 },
    { key: 'onHand', width: 13 },
    { key: 'reserved', width: 13 },
    { key: 'available', width: 13 },
    { key: 'batches', width: 13 },
    { key: 'nearestExpiry', width: 16 },
    { key: 'expiredQty', width: 15 },
    { key: 'nearQty', width: 17 },
    { key: 'status', width: 28 },
  ];

  details.getRow(4).values = [
    c.institution, c.locationType, c.location, c.scientific, c.trade,
    c.national, c.concentration, c.dosage, c.unit, c.onHand, c.reserved,
    c.available, c.batches, c.nearestExpiry, c.expiredQty, c.nearQty, c.status,
  ];
  styleHeader(details.getRow(4));

  for (const item of context.result.rows) {
    const row = details.addRow({
      institution: displayName(item, context.lang),
      locationType: item.scopeKind === 'warehouse' ? c.warehouse : c.outlet,
      location: displayScope(item, context.lang),
      scientific: item.scientificName,
      trade: item.tradeNames.join('، '),
      national: item.nationalCode ?? '',
      concentration: item.concentration.join('، '),
      dosage: item.dosageForm.join('، '),
      unit: item.unit.join('، '),
      onHand: item.onHand,
      reserved: item.reserved,
      available: item.available,
      batches: item.batchCount,
      nearestExpiry: item.nearestExpiry ?? '',
      expiredQty: item.expiredAvailable,
      nearQty: item.nearExpiryAvailable,
      status: statusLabel(item, context.lang),
    });
    row.alignment = { vertical: 'middle', wrapText: true };
    statusFill(row, item.signals);
  }
  details.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: 17 } };
  details.pageSetup.printTitlesRow = '1:4';
  details.pageSetup.printArea = `A1:Q${Math.max(4, details.rowCount)}`;

  const summary = workbook.addWorksheet(c.institutions, {
    views: [{ state: 'frozen', ySplit: 4, rightToLeft: rtl }],
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  summary.mergeCells('A1:H1');
  summary.getCell('A1').value = c.institutions;
  styleTitle(summary.getRow(1));
  summary.columns = [
    { key: 'institution', width: 32 },
    { key: 'locations', width: 14 },
    { key: 'onHand', width: 15 },
    { key: 'reserved', width: 15 },
    { key: 'available', width: 15 },
    { key: 'expiredQty', width: 16 },
    { key: 'nearQty', width: 18 },
    { key: 'status', width: 30 },
  ];
  summary.getRow(4).values = [
    c.institution, c.locations, c.onHand, c.reserved, c.available,
    c.expiredQty, c.nearQty, c.status,
  ];
  styleHeader(summary.getRow(4));

  const byOrganization = new Map<string, {
    name: string;
    locations: Set<string>;
    onHand: number;
    reserved: number;
    available: number;
    expired: number;
    near: number;
    signals: Set<GlobalMaterialSignal>;
  }>();
  for (const item of context.result.rows) {
    let agg = byOrganization.get(item.organizationId);
    if (!agg) {
      agg = {
        name: displayName(item, context.lang),
        locations: new Set(),
        onHand: 0,
        reserved: 0,
        available: 0,
        expired: 0,
        near: 0,
        signals: new Set(),
      };
      byOrganization.set(item.organizationId, agg);
    }
    agg.locations.add(`${item.scopeKind}:${item.scopeId}`);
    agg.onHand += item.onHand;
    agg.reserved += item.reserved;
    agg.available += item.available;
    agg.expired += item.expiredAvailable;
    agg.near += item.nearExpiryAvailable;
    item.signals.forEach(signal => agg?.signals.add(signal));
  }
  for (const agg of [...byOrganization.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const signals = [...agg.signals];
    const row = summary.addRow({
      institution: agg.name,
      locations: agg.locations.size,
      onHand: agg.onHand,
      reserved: agg.reserved,
      available: agg.available,
      expiredQty: agg.expired,
      nearQty: agg.near,
      status: signals.length ? signals.map(signal => SIGNAL[signal][context.lang]).join('، ') : (rtl ? 'متاحة' : 'Available'),
    });
    statusFill(row, signals);
  }
  summary.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: 8 } };
  summary.pageSetup.printTitlesRow = '1:4';

  const definitions = workbook.addWorksheet(c.definitions, {
    views: [{ state: 'frozen', ySplit: 3, rightToLeft: rtl }],
  });
  definitions.mergeCells('A1:B1');
  definitions.getCell('A1').value = c.definitions;
  styleTitle(definitions.getRow(1));
  definitions.columns = [{ key: 'rule', width: 32 }, { key: 'meaning', width: 90 }];
  definitions.getRow(3).values = [c.rule, c.meaning];
  styleHeader(definitions.getRow(3));

  const rules = context.lang === 'ar'
    ? [
        ['المتاح', 'الرصيد الفعلي − المحجوز.'],
        ['المحجوز', 'كميات مرتبطة بطلبات أو تحويلات قيد التنفيذ ولم تُصرف بعد.'],
        ['المفقودة', 'مادة متوقعة في النطاق ورصيدها الفعلي يساوي صفرًا.'],
        ['الشحيحة', 'يحددها مسؤول المذخر عندما يكون المتاح عند حد إعادة الطلب أو دونه.'],
        ['الفائضة', 'يحددها مسؤول المذخر عندما يتجاوز المتاح الحد الأقصى المستهدف.'],
        ['قريبة النفاذ', 'تاريخ الصلاحية خلال 270 يومًا (9 أشهر) أو أقل.'],
      ]
    : [
        ['Available', 'On hand minus reserved.'],
        ['Reserved', 'Quantity tied to an in-progress request or transfer and not yet dispatched.'],
        ['Missing', 'Expected material in the scope with on-hand quantity equal to zero.'],
        ['Low stock', 'Defined by the warehouse manager when available is at or below the reorder point.'],
        ['Surplus', 'Defined by the warehouse manager when available exceeds the target maximum.'],
        ['Near expiry', 'Expiry date is within 270 days (9 months) or less.'],
      ];
  rules.forEach(rule => {
    const row = definitions.addRow({ rule: rule[0], meaning: rule[1] });
    row.alignment = { vertical: 'top', wrapText: true };
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const bytes = new Uint8Array(buffer as unknown as ArrayBuffer);
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `MediStock-${sanitizeFilePart(context.query)}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
