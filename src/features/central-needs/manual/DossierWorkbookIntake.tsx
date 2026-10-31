import { useEffect, useRef, useState } from 'react';
import type { CatalogOption, BeneficiaryOption } from './manual-journey.service';
import type { FileParseResult } from '../import/contract';
import { CentralNeedsError } from '../central-needs.service';
import { parseDossierWorkbook, listDossierSources, downloadDossierSource, type DossierSource } from './dossier-workbook';
import { appendMatrixRegion, capturedMatrix, cellKey, matchingOption, matrixRows, sameWorkbookUnit, type MatrixRegion, type MatrixRow } from './dossier-workbook-matrix';
import { captureDossierWorkbook, resumeDossierWorkbook, IntakeInterrupted } from './dossier-matrix.service';

export interface WorkbookIntakeApi {
  parse: typeof parseDossierWorkbook; save: typeof captureDossierWorkbook; resume: typeof resumeDossierWorkbook;
  sources: typeof listDossierSources; download: typeof downloadDossierSource;
}
const realApi: WorkbookIntakeApi = {parse: parseDossierWorkbook, save: captureDossierWorkbook, resume: resumeDossierWorkbook, sources: listDossierSources, download: downloadDossierSource};
interface Props {
  lang: 'ar' | 'en'; year: number; planId: string; revisionId: string; editable: boolean;
  beneficiaries: BeneficiaryOption[]; search: (q: string) => Promise<CatalogOption[]>;
  onSaved: () => void; api?: WorkbookIntakeApi;
}
export function DossierWorkbookIntake({lang, year, planId, revisionId, editable, beneficiaries, search, onSaved, api = realApi}: Props) {
  const ar = lang === 'ar';
  const [files, setFiles] = useState<File[]>([]);
  const [current, setCurrent] = useState<{filename: string; bytes: Uint8Array; parsed: FileParseResult} | null>(null);
  const [editor, setEditor] = useState({sheet: '0', header: '1', first: '2', last: '2', name: '1', code: '', quantity: '2', unit: '3', beneficiary: ''});
  const [regions, setRegions] = useState<MatrixRegion[]>([]);
  const [rows, setRows] = useState<MatrixRow[]>([]);
  const [page, setPage] = useState(0);
  const [sources, setSources] = useState<DossierSource[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [resumeConsent, setResumeConsent] = useState(false);
  const [reconciled, setReconciled] = useState(false);
  const [pending, setPending] = useState<{operationId: string; intakeId?: string} | null>(null);
  const epoch = useRef(0); const writing = useRef(false); const activeWrite = useRef<AbortController | null>(null);
  const say = (a: string, e: string) => ar ? a : e;
  useEffect(() => {
    activeWrite.current?.abort();
    const mine = ++epoch.current;
    setFiles([]); setCurrent(null); setRows([]); setRegions([]); setPending(null); setError(''); setSources([]); setBusy(false); setConfirmed(false); setNotice(''); setResumeConsent(false); setReconciled(false);
    void api.sources(planId).then((s) => {if (epoch.current === mine) setSources(s);})
      .catch(() => {if (epoch.current === mine) setError(ar ? 'تعذر تحميل سجل الملفات.' : 'Could not load source history.');});
    return () => {activeWrite.current?.abort(); ++epoch.current;};
  }, [planId, revisionId, year, api, ar]);
  const finish = (count: number, consume: boolean) => {
    setNotice(say(`تأكد حفظ ${count} سطرًا.`, `Confirmed ${count} saved rows.`));
    if (consume) {setFiles((old) => old.slice(1)); setCurrent(null); setRows([]); setRegions([]);}
    setPending(null); setConfirmed(false); setResumeConsent(false); setReconciled(false);
    try {onSaved();} catch {setError(say('الحفظ مؤكد؛ تعذر تحديث العرض.', 'Save confirmed; view refresh failed.'));}
  };
  const refresh = async () => {
    const mine = epoch.current; setBusy(true); setError('');
    try {
      const data = await api.sources(planId); if (epoch.current !== mine) return;
      setSources(data);
      if (pending) {
        const found = data.find((s) => s.operation_id === pending.operationId && s.revision_id === revisionId);
        if (found && found.applied_rows === found.rows) finish(found.rows, !!current);
        else if (found) {setPending({...pending, intakeId: found.id}); setReconciled(true); setNotice(say('القراءة أكدت السجل والتقدم؛ الاستكمال يحتاج تأكيدك أدناه.', 'Readback confirmed the capture and progress. Confirm before resuming below.'));}
        else setError(say('لم تؤكد القراءة نتيجة العملية بعد؛ الكتابة باقية موقوفة. لا تعِد رفع الملف.', 'The operation is not reconciled yet. Writes remain paused. Do not re-upload.'));
      }
    } catch {if (epoch.current === mine) setError(say('تعذر تحديث السجل؛ لا تغيّر في حالة التأكيد.', 'History read failed; confirmation state is unchanged.'));}
    finally {if (epoch.current === mine) setBusy(false);}
  };
  const parseNext = async () => {
    const file = files[0]; if (!file || pending) return;
    const mine = epoch.current; setBusy(true); setError(''); setRows([]); setRegions([]); setConfirmed(false);
    try {
      const result = await api.parse(file); if (epoch.current !== mine) return;
      const first = result.parsed.workbook!.sheets.find((s) => s.cells.length) ?? result.parsed.workbook!.sheets[0];
      if (!first) throw new Error('empty_workbook');
      setCurrent({filename: file.name, ...result}); setPage(0);
      setEditor((e) => ({...e, sheet: String(first.index), last: String(first.cells.reduce((last,c) => Math.max(last,c.coordinate.row + 1),2))}));
    } catch {if (epoch.current === mine) setError(say('تعذر تحليل الملف. لم يُرسل للحفظ.', 'File parse failed. Nothing was submitted for saving.'));}
    finally {if (epoch.current === mine) setBusy(false);}
  };
  const addRegion = () => {
    if (!current) return;
    try {
      const sheet = current.parsed.workbook!.sheets.find((s) => s.index === Number(editor.sheet));
      if (!sheet || !beneficiaries.some((b) => b.id === editor.beneficiary)) throw new Error('beneficiary_required');
      const region: MatrixRegion = {sheet: sheet.index, headerRow: Number(editor.header)-1, firstRow: Number(editor.first), lastRow: Number(editor.last),
        name: Number(editor.name)-1, code: editor.code === '' ? null : Number(editor.code)-1, quantity: Number(editor.quantity)-1, unit: Number(editor.unit)-1, beneficiaryId: editor.beneficiary, beneficiaryLabel: beneficiaries.find((b) => b.id === editor.beneficiary)?.name,
        quantityHeader: sheet.cells.filter((c) => c.coordinate.col === Number(editor.quantity)-1 && c.coordinate.row < Number(editor.header) && c.presence === 'value').map((c) => String(c.rawValue ?? '')).join(' / ')};
      setRows(appendMatrixRegion(rows, matrixRows(sheet, region))); setRegions([...regions, region]); setConfirmed(false); setError('');
    } catch {setError(say('تحقق من المؤسسة وحدود الصفوف والأعمدة؛ لا تكرر خلية سبق اختيارها. الحد 10000 خلية كمية.', 'Check beneficiary, row bounds and distinct columns. A physical quantity cell may be selected once. Maximum 10000 quantity cells.'));}
  };
  const match = async (indices: number[]) => {
    const mine = epoch.current; setBusy(true); setError(''); setConfirmed(false);
    const cache = new Map<string, CatalogOption[]>();
    try {
      for (const index of indices) {
        const row = rows[index]; if (!row || row.excluded || row.error) continue;
        const key = row.code ?? row.name;
        let options = cache.get(key); if (!options) {options = await search(key); cache.set(key, options);}
        if (epoch.current !== mine) return;
        const matches = options; const exact = matches.filter((m) => !!row.code && m.nationalCode === row.code && sameWorkbookUnit(row.unit, m.unit));
        setRows((old) => old.map((r, i) => i === index ? {...r, matches, selected: exact.length === 1 ? exact[0].id : ''} : r));
      }
    } catch {if (epoch.current === mine) setError(say('فشل البحث؛ لم تُعتبر المادة غير موجودة. المقترحات تحتاج مراجعتك.', 'Search failed; this does not mean the item is absent. Suggestions still require confirmation.'));}
    finally {if (epoch.current === mine) setBusy(false);}
  };
  let valid = false;
  try {capturedMatrix(rows); valid = true;} catch { /* Unresolved or unexplained exclusions block capture. */ }
  const save = async () => {
    if (!current || !valid || !confirmed || pending || writing.current) return;
    const mine = epoch.current; const controller = new AbortController(); activeWrite.current = controller; const operationId = crypto.randomUUID(); writing.current = true; setBusy(true); setError(''); setReconciled(false); setResumeConsent(false); setPending({operationId});
    try {
      const capture = capturedMatrix(rows);
      const result = await api.save({planId, revisionId, filename: current.filename, bytes: current.bytes, operationId, year,
        rows: capture.selections, exclusions: capture.exclusions, regions, signal: controller.signal});
      if (epoch.current !== mine) return;
      finish(result.rows, true);
      try {const s = await api.sources(planId); if (epoch.current === mine) setSources(s);} catch {if (epoch.current === mine) setError(say('الحفظ مؤكد؛ تعذر تحديث سجل الملفات.', 'Save confirmed; source history refresh failed.'));}
    } catch (e) {
      if (epoch.current !== mine) return;
      if (e instanceof CentralNeedsError) {
        setPending(null);
        const duplicate = ['dossier_existing_manual_scope','dossier_duplicate_selection'].includes(e.businessCode);
        setError(duplicate
          ? say('يوجد احتياج للمادة والمؤسسة أو اختيار مكرر. راجعه أو صححه من مساحة الإدخال؛ لم تُلتقط هذه الخطة.', 'A material/beneficiary scope already exists or a cell is duplicated. Review or correct the existing entry; this plan was not captured.')
          : say('رفض الخادم التقاط الخطة. تحقق من الصلاحيات والسنة والوحدات والأكواد؛ لم نعد الطلب.', 'The server refused this capture. Check permissions, year, units and codes. No request was retried.'));
      }
      else {
        if (e instanceof IntakeInterrupted && e.intakeId) setPending({operationId, intakeId: e.intakeId});
        setError(say('الحفظ متوقف: قد تكون بعض الدفعات مؤكدة. حدّث السجل قراءةً ثم أكد الاستكمال؛ لا نكرر الطلب تلقائيًا.', 'Saving is paused; some batches may already be confirmed. Read source history, then explicitly confirm resume. No request was retried.'));
      }
    } finally {writing.current = false; if (epoch.current === mine) setBusy(false);}
  };
  const resume = async (source: DossierSource) => {
    if (!resumeConsent || writing.current) return;
    const mine = epoch.current; const controller = new AbortController(); activeWrite.current = controller; writing.current = true; setBusy(true); setError(''); setReconciled(false); setResumeConsent(false); setPending({operationId: source.operation_id ?? '', intakeId: source.id});
    try {
      const result = await api.resume(planId, revisionId, source.id, controller.signal); if (epoch.current !== mine) return;
      finish(result.rows, !!current && pending?.operationId === source.operation_id);
      try {const s = await api.sources(planId); if (epoch.current === mine) setSources(s);} catch {if (epoch.current === mine) setError(say('الاستكمال مؤكد؛ تعذر تحديث السجل.', 'Resume confirmed; history refresh failed.'));}
    } catch {if (epoch.current === mine) setError(say('توقف الاستكمال. اقرأ السجل مجددًا قبل أي إجراء.', 'Resume stopped. Read history again before another action.'));}
    finally {writing.current = false; if (epoch.current === mine) setBusy(false);}
  };
  const download = async (id: string) => {
    const mine = epoch.current; setBusy(true); setError('');
    try {
      const d = await api.download(id); if (epoch.current !== mine) return;
      const url = URL.createObjectURL(new Blob([d.bytes.slice().buffer])); const a = document.createElement('a'); a.href = url; a.download = d.filename; a.click(); URL.revokeObjectURL(url);
    } catch {if (epoch.current === mine) setError(say('تعذر تنزيل الأصل أو التحقق من بصمته.', 'Source download or integrity check failed.'));}
    finally {if (epoch.current === mine) setBusy(false);}
  };
  const patchRow = (index: number, patch: Partial<MatrixRow>) => {setRows((old) => old.map((r, i) => i === index ? {...r, ...patch} : r)); setConfirmed(false);};
  const selectedSheet = current?.parsed.workbook?.sheets.find((s) => s.index === Number(editor.sheet));
  const sourceHeader = selectedSheet?.cells.filter((c) => c.coordinate.col === Number(editor.quantity)-1 && c.coordinate.row < Number(editor.header) && c.presence === 'value').map((c) => String(c.rawValue ?? '')).join(' / ');
  return <section style={{minWidth:0,maxWidth:'100%'}} aria-label={say('ملفات حزمة الاحتياج', 'Dossier workbooks')}>
    <h3>{say('ملفات حزمة الاحتياج', 'Dossier workbooks')}</h3>
    <p>{say('اختر منطقة وعمود كمية لكل مؤسسة، ثم راجع الخلايا. لا جمع أو استبدال تلقائي. تُحفظ الخطة والمصدر ثم دفعات 100 سطر بإيصالات؛ لا اعتماد قبل اكتمالها. الحد 5 ملفات و3 ميغابايت لكل ملف و10000 خلية كمية للخطة.', 'Map each region and beneficiary quantity column, then review cells. No automatic sum or overwrite. Capture evidence first, then apply 100-row receipted batches. Submission is blocked until complete. Up to 5 files, 3 MB each, 10000 quantity cells per capture.')}</p>
    {error && <p role="alert">{error}</p>}<p role="status">{notice}</p>
    <button disabled={busy} onClick={() => void refresh()}>{say('تحديث سجل الملفات (قراءة فقط)', 'Refresh source history (read only)')}</button>
    <ul>{sources.map((s) => <li key={s.id}>{s.filename} · {s.applied_rows ?? s.rows}/{s.rows}
      <button disabled={busy} onClick={() => void download(s.id)}>{say('تنزيل الأصل', 'Download original')}</button>
      {editable && s.revision_id === revisionId && s.can_resume && s.applied_rows !== undefined && s.applied_rows < s.rows && <button
        disabled={busy || !resumeConsent || !!pending && (!reconciled || pending.intakeId !== s.id)} onClick={() => void resume(s)}>{say('استكمال الخطة المحفوظة', 'Resume captured plan')}</button>}
    </li>)}</ul>
    {editable && <label><input type="checkbox" checked={resumeConsent} disabled={busy} onChange={(e) => setResumeConsent(e.target.checked)} />{say('راجعت تقدم السجل وأوافق على استكمال الدفعات المتبقية فقط.', 'I reviewed saved progress and confirm only the remaining captured batches.')}</label>}
    {editable && <>
      <label>{say('اختيار ملفات الاحتياج', 'Choose needs files')}<input type="file" multiple accept=".xlsx,.xls,.csv" disabled={busy || !!pending || !!current} onChange={(e) => {
        const supplied = Array.from(e.target.files ?? []); e.currentTarget.value = ''; const clean = supplied.filter((f) => !f.name.startsWith('~$'));
        if (clean.length > 5 || clean.some((f) => !f.size || f.size > 3*1024*1024)) {setError(say('تجاوز عدد الملفات أو الحجم.', 'File count or size limit exceeded.')); return;}
        setFiles(clean); setNotice(supplied.length !== clean.length ? say('استُبعدت ملفات قفل Office؛ لم تُحلل.', 'Office lock files were excluded before parsing.') : '');
      }} /></label>
      <ol>{files.map((f,i) => <li key={`${i}:${f.name}`}>{f.name}</li>)}</ol>
      <button disabled={busy || !!pending || !files.length} onClick={() => {setFiles((old) => old.slice(1)); setCurrent(null); setRows([]); setRegions([]); setConfirmed(false); setPage(0);}}>{say('تجاوز الملف غير المحفوظ', 'Skip unconfirmed file')}</button>
      <button disabled={busy || !!pending || !files.length} onClick={() => {setFiles([]); setCurrent(null); setRows([]); setRegions([]); setConfirmed(false); setPage(0);}}>{say('إلغاء قائمة الملفات غير المحفوظة', 'Clear unprocessed file queue')}</button>
      {!current && <button disabled={busy || !!pending || !files.length} onClick={() => void parseNext()}>{say('معاينة الملف التالي', 'Preview next file')}</button>}
      {current && <fieldset style={{minWidth:0}} disabled={busy || !!pending}><legend>{current.filename}</legend>
        <label>{say('الورقة', 'Sheet')}<select value={editor.sheet} onChange={(e) => {const s = current.parsed.workbook!.sheets.find((v) => v.index === Number(e.target.value)); setEditor({...editor, sheet: e.target.value, last: String(s?.cells.reduce((last,c) => Math.max(last,c.coordinate.row + 1),2) ?? 2)}); setConfirmed(false);}}>{current.parsed.workbook!.sheets.map((s) => <option key={s.index} value={s.index}>{s.name}</option>)}</select></label>
        <label>{say('المؤسسة لهذا العمود والمنطقة', 'Beneficiary for this column and region')}<select value={editor.beneficiary} onChange={(e) => {setEditor({...editor, beneficiary: e.target.value}); setConfirmed(false);}}><option value="">—</option>{beneficiaries.map((b) => <option key={b.id} value={b.id}>{ar && b.nameAr ? b.nameAr : b.name}</option>)}</select></label>
        <p>{say('الأعمدة A=1، B=2… اختر كتلة الهوية الصحيحة واستبعد عمود الإجمالي/الفرق. عنوان المؤسسة اقتراح لا تعيين تلقائي.', 'Columns A=1, B=2… Choose the intended identity block; do not select totals/differences as a beneficiary. Headers are evidence, not automatic assignments.')}</p>
        {(['header','first','last','name','code','quantity','unit'] as const).map((key) => <label key={key}>{({header: say('صف العناوين','Header row'),first: say('أول صف بيانات','First data row'),last: say('آخر صف بيانات','Last data row'),name: say('عمود اسم المادة','Material column'),code: say('عمود الرمز الوطني','National code column'),quantity: say('عمود الكمية','Quantity column'),unit: say('عمود الوحدة','Unit column')})[key]}<input inputMode="numeric" value={editor[key]} onChange={(e) => {setEditor({...editor, [key]: e.target.value}); setConfirmed(false);}} /></label>)}
        <p>{say('عنوان عمود الكمية من المصدر:', 'Source quantity-column header:')} <b>{sourceHeader || '—'}</b> · {say('السنة المستهدفة:', 'Target year:')} {year}</p>
        <button onClick={addRegion}>{say('إضافة المنطقة للمراجعة', 'Add region for review')}</button>
        <button disabled={!rows.length} onClick={() => {setRows([]); setRegions([]); setConfirmed(false); setPage(0);}}>{say('مسح خطة المعاينة فقط', 'Clear preview plan only')}</button>
        <p>{say(`المناطق ${regions.length}؛ الخلايا ${rows.length}.`, `${regions.length} regions; ${rows.length} cells.`)}</p>
        {rows.length > 0 && <>
          <button onClick={() => void match(rows.map((_,i) => i).filter((i) => !rows[i].excluded && !rows[i].error && !matchingOption(rows[i])).slice(0,100))}>{say('اقتراح تطابقات 100 خلية تالية', 'Suggest matches for next 100 cells')}</button>
          <button onClick={() => {setRows((old) => old.map((r) => !r.quantityText ? {...r, excluded: true, exclusionReason: say('خلية كمية فارغة أو غير قابلة للاعتماد؛ استبعاد مؤكد ضمن هذه المنطقة', 'Confirmed exclusion: blank or unusable quantity cell within this region')} : r)); setConfirmed(false);}}>{say('تأكيد استبعاد خلايا الكمية الفارغة/غير الصالحة', 'Confirm exclusion of blank/unusable quantity cells')}</button>
          <div role="region" aria-label={say('معاينة خلايا المصدر','Source cell preview')} style={{overflowX:'auto',maxWidth:'100%'}}><table><thead><tr>{(ar ? ['الخلية والمؤسسة','المادة والرمز','الكمية والوحدة','المادة المعتمدة','الاستبعاد وسببه'] : ['Cell and beneficiary','Source name and code','Quantity and unit','Registered material','Exclusion and reason']).map((h) => <th scope="col" key={h}>{h}</th>)}</tr></thead><tbody>{rows.slice(page*50,page*50+50).map((r,j) => {const i=page*50+j; return <tr key={cellKey(r)}><td>{r.sheet+1}:{r.row}:{r.quantityColumn+1} · {beneficiaries.find((b) => b.id === r.beneficiaryId)?.name}</td><td>{r.name}<br />{r.code ?? '—'}</td><td>{r.quantityText || '—'} · {r.unit}{r.error && <p role="note">{r.error}</p>}</td><td><button disabled={r.excluded || !!r.error} onClick={() => void match([i])}>{say('بحث عن المادة','Find material')}</button><select aria-label={`${say('مادة الخلية','Material for cell')} ${cellKey(r)}`} value={r.selected} disabled={r.excluded} onChange={(e) => patchRow(i,{selected: e.target.value})}><option value="">—</option>{r.matches.map((m) => <option key={m.id} value={m.id} disabled={!sameWorkbookUnit(r.unit,m.unit) || !!r.code && m.nationalCode !== r.code}>{[m.nationalCode,ar && m.nameAr ? m.nameAr : m.name,m.unit].filter(Boolean).join(' · ')}</option>)}</select></td><td><label><input type="checkbox" checked={r.excluded} onChange={(e) => patchRow(i,{excluded: e.target.checked})} />{say('استبعاد','Exclude')} {cellKey(r)}</label>{r.excluded && <input aria-label={`${say('سبب استبعاد','Exclusion reason')} ${cellKey(r)}`} value={r.exclusionReason} onChange={(e) => patchRow(i,{exclusionReason: e.target.value})} />}</td></tr>;})}</tbody></table></div>
          <button disabled={page === 0} onClick={() => setPage((n) => n-1)}>{say('السابق','Previous')}</button><span>{page+1}/{Math.ceil(rows.length/50)}</span><button disabled={(page+1)*50 >= rows.length} onClick={() => setPage((n) => n+1)}>{say('التالي','Next')}</button>
          <p>{say('الوحدات غير المتكافئة تحتاج حسمًا؛ لا تحويل kit إلى test أو عبوة إلى قطعة. لا إنشاء مادة أو جمع تكرار تلقائي.', 'Resolve incompatible units explicitly; no kit-to-test or pack-to-piece conversion. No automatic material creation or duplicate sum.')}</p>
          <label><input type="checkbox" checked={confirmed} disabled={!valid} onChange={(e) => setConfirmed(e.target.checked)} />{say('راجعت السنة والمؤسسات والأكواد والوحدات والكميات والاستبعادات. أعتمد هذه الخطة للإدخال.', 'I confirmed the year, beneficiaries, codes, units, quantities and exclusions for this captured plan.')}</label>
          <button disabled={!valid || !confirmed} onClick={() => void save()}>{say('حفظ الخطة وتطبيق دفعاتها','Capture plan and apply batches')}</button>
        </>}
      </fieldset>}
    </>}
  </section>;
}
