/** M114 compatibility is based on column presence, never `national_code ?? barcode`.
 * A NULL new column means "not recorded", not a licence to reinterpret barcode.
 */
export function catalogNationalCode(row: { national_code?: string | null; barcode?: string | null }): string | null {
  const value = Object.prototype.hasOwnProperty.call(row, 'national_code') ? row.national_code : row.barcode;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function isMissingNationalCodeColumn(error: { code?: string; message?: string } | null): boolean {
  return (error?.code === '42703' || error?.code === 'PGRST204') && (error.message ?? '').includes('national_code');
}
