import { useEffect, useRef, useState } from 'react';
import type { CatalogOption, BeneficiaryOption } from './manual-journey.service';
import type { FileParseResult } from '../import/contract';
import { CentralNeedsError } from '../central-needs.service';
import { parseDossierWorkbook, previewWorkbookRows, importDossierWorkbook, listDossierSources, downloadDossierSource,
  type DossierSource, type WorkbookPreviewRow } from './dossier-workbook';

export interface WorkbookIntakeApi {
  parse: typeof parseDossierWorkbook; save: typeof importDossierWorkbook;
  sources: typeof listDossierSources; download: typeof downloadDossierSource;
}
const realApi: WorkbookIntakeApi = { parse: parseDossierWorkbook, save: importDossierWorkbook, sources: listDossierSources, download: downloadDossierSource };
interface Props {
  lang: 'ar' | 'en'; planId: string; revisionId: string; editable: boolean;
  beneficiaries: BeneficiaryOption[]; search: (q: string) => Promise<CatalogOption[]>;
  onSaved: () => void; api?: WorkbookIntakeApi;
}
type ReviewRow = WorkbookPreviewRow & { matches: CatalogOption[]; selected: string };

/** A queue, not a blind multi-file write. Each file has its own explicit confirmation
 * and atomic server transaction. Prior confirmed files remain visible if a later one fails.
 */
export function DossierWorkbookIntake({ lang, planId, revisionId, editable, beneficiaries, search, onSaved, api = realApi }: Props) {
  const ar = lang === 'ar';
  const [files, setFiles] = useState<File[]>([]);
  const [current, setCurrent] = useState<{ filename: string; bytes: Uint8Array; parsed: FileParseResult } | null>(null);
  const [sheet, setSheet] = useState(0);
  const [header, setHeader] = useState('1');
  const [cols, setCols] = useState({ name: '1', code: '', quantity: '2', unit: '3' });
  const [beneficiary, setBeneficiary] = useState('');
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [sources, setSources] = useState<DossierSource[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unknown, setUnknown] = useState(false);
  const [notice, setNotice] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const epoch = useRef(0);

  useEffect(() => {
    const mine = ++epoch.current;
    setFiles([]); setCurrent(null); setRows([]); setUnknown(false); setError(''); setSources([]); setBusy(false); setConfirmed(false); setNotice('');
    void api.sources(planId).then((s) => { if (epoch.current === mine) setSources(s); })
      .catch(() => { if (epoch.current === mine) setError(ar ? 'تعذر تحميل سجل الملفات.' : 'Could not load source history.'); });
    return () => { ++epoch.current; };
  }, [planId, revisionId, api, ar]);

  const parseNext = async () => {
    const file = files[0]; if (!file) return;
    const mine = epoch.current; setBusy(true); setError(''); setNotice(''); setRows([]); setConfirmed(false);
    try {
      const r = await api.parse(file);
      if (epoch.current !== mine) return;
      setCurrent({ filename: file.name, ...r }); setSheet(r.parsed.workbook!.sheets[0].index);
    } catch (e) { if (epoch.current === mine) setError(ar ? 'تعذر تحليل الملف أو تجاوز حد الحجم/الصفوف. لم يُحفظ شيء.' : `File could not be parsed: ${e instanceof Error ? e.message : 'parse_failed'}. Nothing was saved.`); }
    finally { if (epoch.current === mine) setBusy(false); }
  };
  const prepare = () => {
    if (!current) return;
    try {
      const s = current.parsed.workbook!.sheets.find((x) => x.index === sheet);
      if (!s || !beneficiary) throw new Error('beneficiary_required');
      const parsed = previewWorkbookRows(s, { headerRow: Number(header)-1, name: Number(cols.name)-1,
        quantity: Number(cols.quantity)-1, unit: Number(cols.unit)-1, code: cols.code === '' ? null : Number(cols.code)-1 });
      setRows(parsed.map((r) => ({ ...r, matches: [], selected: '' }))); setConfirmed(false); setError('');
    } catch { setError(ar ? 'تحقق من المؤسسة وأرقام الأعمدة وصف العناوين؛ الحد 100 سطر لكل ملف.' : 'Check beneficiary, header and column numbers. Maximum 100 rows per file.'); }
  };
  const match = async (index: number) => {
    const row = rows[index]; const mine = epoch.current; setBusy(true); setError('');
    try {
      const found = await search(row.code ?? row.name);
      if (epoch.current !== mine) return;
      setRows((old) => old.map((r,i) => i === index ? { ...r, matches: found, selected: '' } : r)); setConfirmed(false);
    } catch { if (epoch.current === mine) setError(ar ? 'فشل البحث. لم تُعتبر المادة غير موجودة.' : 'Search failed; this does not mean the material is absent.'); }
    finally { if (epoch.current === mine) setBusy(false); }
  };
  const valid = rows.length>0 && rows.every((r) => !r.error && r.matches.some((m) => m.id===r.selected && m.unit===r.unit && (!r.code || m.nationalCode===r.code)))
    && new Set(rows.map((r) => r.selected)).size===rows.length;

  const save = async () => {
    if (!current || !valid || !confirmed || unknown) return;
    const captured = current; const capturedRows = rows.map((r) => ({ sheet:r.sheet,row:r.row,quantity_column:r.quantityColumn,
      name_column:Number(cols.name)-1,code_column:cols.code===''?null:Number(cols.code)-1,unit_column:Number(cols.unit)-1,source_name:r.name,source_code:r.code,quantity_text:r.quantityText,unit:r.unit,item_id:r.selected,beneficiary_id:beneficiary }));
    const mine = epoch.current; setBusy(true); setError('');
    try {
      const result = await api.save(revisionId, captured.filename, captured.bytes, capturedRows);
      if (epoch.current !== mine) return;
      // Success is established by the RPC. A readback error must not invite a duplicate write.
      setNotice(ar ? `تم حفظ ${result.rows} سطرًا من ${captured.filename}.` : `Saved ${result.rows} rows from ${captured.filename}.`);
      setFiles((old) => old.slice(1)); setCurrent(null); setRows([]); setConfirmed(false); onSaved();
      try { const s=await api.sources(planId); if (epoch.current===mine) setSources(s); }
      catch { if(epoch.current===mine) setError(ar ? 'الحفظ مؤكد، لكن تعذر تحديث سجل الملفات.' : 'Save confirmed; source history refresh failed.'); }
    } catch (e) {
      if (epoch.current !== mine) return;
      if (e instanceof CentralNeedsError) setError(ar ? `رفض الخادم الحفظ: ${e.businessCode}. لم نعد المحاولة.` : `Server refused: ${e.businessCode}. No retry was made.`);
      else { setUnknown(true); setError(ar ? 'تعذر تأكيد نتيجة الحفظ. أوقفنا الكتابة؛ افحص سجل الملفات قبل أي محاولة أخرى.' : 'Save outcome is unknown. Writes are stopped; reconcile source history before another attempt.'); }
    } finally { if(epoch.current===mine) setBusy(false); }
  };
  const download = async (id: string) => {
    setBusy(true); setError('');
    try {
      const data = await api.download(id);
      const url = URL.createObjectURL(new Blob([data.bytes.slice().buffer], { type:'application/octet-stream' }));
      const a=document.createElement('a'); a.href=url; a.download=data.filename; a.click(); URL.revokeObjectURL(url);
    } catch { setError(ar ? 'تعذر تنزيل المصدر أو التحقق من بصمته.' : 'Source download or integrity check failed.'); }
    finally { setBusy(false); }
  };

  return <section aria-label={ar ? 'ملفات حزمة الاحتياج' : 'Dossier workbooks'}>
    <h3>{ar ? 'ملفات حزمة الاحتياج' : 'Dossier workbooks'}</h3>
    <p>{ar ? 'كل ملف يُراجع ويُحفظ منفصلًا. لا جمع أو استبدال تلقائي للكميات. الحد 5 ملفات، 3 ميغابايت و100 سطر لكل ملف.' : 'Review and confirm each file separately. Quantities are never automatically summed or overwritten. Up to 5 files, 3 MB and 100 rows each.'}</p>
    {error && <p role="alert">{error}</p>}<p role="status">{notice}</p>
    <button disabled={busy} onClick={()=>{
      const mine=epoch.current;
      void api.sources(planId).then((s)=>{if(epoch.current===mine)setSources(s);})
        .catch(()=>{if(epoch.current===mine)setError(ar?'تعذر تحديث سجل الملفات.':'Could not refresh source history.');});
    }}>{ar?'تحديث سجل الملفات (قراءة فقط)':'Refresh source history (read only)'}</button>
    <ul>{sources.map((s) => <li key={s.id}>{s.filename} · {s.rows} <button disabled={busy} onClick={() => void download(s.id)}>{ar ? 'تنزيل الأصل' : 'Download original'}</button></li>)}</ul>
    {editable && <>
      <label>{ar ? 'اختيار ملفات الاحتياج' : 'Choose needs files'}<input type="file" multiple accept=".xlsx,.xls,.csv" disabled={busy || unknown || !!current}
        onChange={(e) => { const list=Array.from(e.target.files ?? []); if(list.length>5 || list.some((f) => f.size>3*1024*1024)) { setError(ar ? 'تجاوز حد الملفات أو الحجم.' : 'File count or size limit exceeded.'); return; } setFiles(list); setCurrent(null); setRows([]); setConfirmed(false); }} /></label>
      <ol>{files.map((f,i) => <li key={`${i}:${f.name}`}>{f.name}</li>)}</ol>
      {!current && <button disabled={busy || unknown || files.length===0} onClick={() => void parseNext()}>{ar ? 'معاينة الملف التالي' : 'Preview next file'}</button>}
      {current && <fieldset disabled={busy || unknown}><legend>{current.filename}</legend>
        <label>{ar ? 'الورقة' : 'Sheet'}<select value={sheet} onChange={(e)=>{setSheet(Number(e.target.value));setRows([]);setConfirmed(false);}}>{current.parsed.workbook!.sheets.map((s)=><option key={s.index} value={s.index}>{s.name}</option>)}</select></label>
        <label>{ar ? 'صف العناوين' : 'Header row'}<input inputMode="numeric" value={header} onChange={(e)=>{setHeader(e.target.value);setRows([]);}} /></label>
        <label>{ar ? 'المؤسسة المستفيدة لجميع سطور هذا الملف' : 'Beneficiary for all rows in this file'}<select value={beneficiary} onChange={(e)=>{setBeneficiary(e.target.value);setRows([]);setConfirmed(false);}}><option value="">—</option>{beneficiaries.map((b)=><option key={b.id} value={b.id}>{ar && b.nameAr ? b.nameAr : b.name}</option>)}</select></label>
        <p>{ar ? 'رقم العمود: A=1، B=2… الرمز الوطني اختياري. اعرض الملف الأصلي لتحديد الأعمدة.' : 'Column numbers: A=1, B=2… National code is optional. Check the original workbook.'}</p>
        {(['name','code','quantity','unit'] as const).map((key)=><label key={key}>{({name:ar?'عمود اسم المادة':'Material column',code:ar?'عمود الرمز الوطني':'National code column',quantity:ar?'عمود الكمية':'Quantity column',unit:ar?'عمود الوحدة':'Unit column'})[key]}<input inputMode="numeric" value={cols[key]} onChange={(e)=>{setCols({...cols,[key]:e.target.value});setRows([]);setConfirmed(false);}} /></label>)}
        <button onClick={prepare}>{ar ? 'عرض السطور للمراجعة' : 'Review rows'}</button>
        {rows.length>0 && <table><thead><tr>{(ar?['السطر','المادة والمصدر','الرمز الوطني','الكمية','الوحدة','المادة المعتمدة']:['Row','Source material','National code','Quantity','Unit','Registered material']).map((h)=><th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={r.row}><td>{r.row}</td><td>{r.name}{r.error && <p role="alert">{ar ? 'بيانات غير صالحة؛ صحح الملف ثم أعد معاينته.' : r.error}</p>}</td><td dir="ltr">{r.code ?? '—'}</td><td dir="ltr">{r.quantityText}</td><td>{r.unit}</td><td><button disabled={!!r.error} onClick={()=>void match(i)}>{ar?'بحث عن المادة':'Find material'}</button><select aria-label={`${ar?'مادة السطر':'Material for row'} ${r.row}`} value={r.selected} onChange={(e)=>{setRows((old)=>old.map((v,j)=>j===i?{...v,selected:e.target.value}:v));setConfirmed(false);}}><option value="">—</option>{r.matches.map((m)=><option key={m.id} value={m.id} disabled={m.unit!==r.unit || !!r.code && m.nationalCode!==r.code}>{[m.nationalCode, ar&&m.nameAr?m.nameAr:m.name,m.concentration,m.dosageForm,m.unit].filter(Boolean).join(' · ')}</option>)}</select></td></tr>)}</tbody></table>}
        {rows.length>0 && <p>{ar ? 'المواد غير المسجلة أو الملتبسة تحتاج تسجيلًا أو حسمًا؛ لن تُنشأ تلقائيًا. السطور المكررة تمنع الحفظ.' : 'Unregistered or ambiguous materials require registration or resolution. They are never auto-created. Duplicate rows block saving.'}</p>}
        <label><input type="checkbox" checked={confirmed} disabled={!valid} onChange={(e)=>setConfirmed(e.target.checked)} />{ar ? 'راجعت المؤسسة والمواد والوحدات والكميات لجميع السطور.' : 'I checked the beneficiary, materials, units and quantities for every row.'}</label>
        <button disabled={!valid || !confirmed} onClick={()=>void save()}>{ar?'حفظ سطور هذا الملف':'Save this file’s rows'}</button>
      </fieldset>}
    </>}
  </section>;
}
