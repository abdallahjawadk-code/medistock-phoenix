/**
 * R1 functional acceptance journey (F3) - ONE journey, two transports.
 *
 * The journey talks to the product ONLY through its public RPCs, exactly as the application does, as three actors: `anon`, `maker`, `checker`.
 * A transport is `{ call(actor, fn, args) -> { data, error }, items(actor) -> [{ id, name }] }`:
 *   - local:   a disposable PostgreSQL, impersonating the `authenticated` / `anon` role per call (tests only);
 *   - Staging: supabase-js sessions signed in with the two test accounts (see functional-acceptance.mjs).
 * The journey never prints, stores or returns a credential, a token or an e-mail address; it returns step records only.
 * It writes through the product's own routines, so on Staging it leaves ordinary test data in the isolated test organization (cleaned by the reset template v2).
 */
import { randomUUID } from 'node:crypto';

// a refusal is a DATABASE answer (it carries an SQLSTATE / PostgREST code); a dropped connection or a missing function must never count as a pass
const refused = (res) => Boolean(res && res.error && /^[0-9A-Z]{5}$/.test(String(res.error.code ?? '')) && res.error.code !== 'PGRST');
const code = (res) => String(res?.error?.code ?? res?.error?.message ?? '').slice(0, 80);

/**
 * @param {{ call: Function, items: Function }} t
 * @param {{ orgId: string, beneficiaryId: string, planYear: number, log?: Function }} ctx
 */
export async function runJourney(t, ctx) {
  const steps = []; const state = {}; let blocked = null;
  const rec = (id, ok, detail = '') => { steps.push({ id, ok: Boolean(ok), detail: String(detail).slice(0, 160) }); ctx.log?.(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ' - ' + String(detail).slice(0, 120) : ''}`); return ok; };
  /** run a step only while nothing before it failed; the first failure blocks the dependants (they are recorded, not hidden). */
  const step = async (id, fn) => {
    if (blocked) { steps.push({ id, ok: false, detail: `blocked by ${blocked}` }); ctx.log?.(`FAIL ${id} - blocked by ${blocked}`); return; }
    try { const r = await fn(); if (!rec(id, r === true || r?.ok === true, r?.detail ?? '')) blocked = id; }
    catch (e) { rec(id, false, `exception: ${e?.message ?? e}`); blocked = id; }
  };
  const ok = (res, what) => (res.error ? { ok: false, detail: `${what}: ${code(res)} ${String(res.error.message ?? '').slice(0, 80)}` } : null);
  const o = ctx.orgId; const b = ctx.beneficiaryId; const y = ctx.planYear;

  await step('anon-refused-everywhere', async () => {
    const calls = [['phoenix_central_needs_open_manual_plan_revision', { p_organization_id: o, p_plan_year: y }], ['phoenix_central_needs_my_capabilities', { p_organization_id: o, p_plan_revision_id: null }],
      ['phoenix_central_needs_create_material_request_draft', { p_organization_id: o, p_scientific_name: 'x', p_name_ar: null, p_trade_name: null, p_strength: null, p_dosage_form: null, p_unit: 'box', p_barcode: null, p_note: null, p_provenance_kind: 'manual_typed', p_provenance: {}, p_plan_revision_id: null, p_idempotency_key: randomUUID() }]];
    for (const [fn, args] of calls) if (!refused(await t.call('anon', fn, args))) return { ok: false, detail: `${fn} was NOT refused for anon` };
    return true;
  });

  await step('capabilities-maker', async () => {
    const r = await t.call('maker', 'phoenix_central_needs_my_capabilities', { p_organization_id: o, p_plan_revision_id: null });
    const e = ok(r, 'maker capabilities'); if (e) return e;
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    return { ok: row?.view === true && row?.edit === true && row?.manual_set === true && row?.approve !== true, detail: `view=${row?.view} edit=${row?.edit} set=${row?.manual_set} approve=${row?.approve}` };
  });
  await step('capabilities-checker', async () => {
    const r = await t.call('checker', 'phoenix_central_needs_my_capabilities', { p_organization_id: o, p_plan_revision_id: null });
    const e = ok(r, 'checker capabilities'); if (e) return e;
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    return { ok: row?.view === true && row?.approve === true && row?.manual_set !== true && row?.edit !== true, detail: `view=${row?.view} approve=${row?.approve} set=${row?.manual_set} edit=${row?.edit}` };
  });
  await step('material-capabilities', async () => {
    const m = await t.call('maker', 'phoenix_central_needs_my_material_capabilities', { p_organization_id: o });
    const c = await t.call('checker', 'phoenix_central_needs_my_material_capabilities', { p_organization_id: o });
    const e = ok(m, 'maker') ?? ok(c, 'checker'); if (e) return e;
    const mr = Array.isArray(m.data) ? m.data[0] : m.data; const cr = Array.isArray(c.data) ? c.data[0] : c.data;
    return { ok: mr?.can_request === true && mr?.can_review !== true && cr?.can_review === true, detail: `maker request=${mr?.can_request} review=${mr?.can_review}; checker review=${cr?.can_review}` };
  });

  await step('catalogue-visible-to-maker', async () => {
    const items = await t.items('maker');
    if (!items || items.length < 2) return { ok: false, detail: `the maker sees ${items?.length ?? 0} synthetic catalogue item(s), expected >= 2` };
    state.itemA = items[0].id; state.itemB = items[1].id;
    return true;
  });

  await step('year-first-open-revision-maker', async () => {
    const r = await t.call('maker', 'phoenix_central_needs_open_manual_plan_revision', { p_organization_id: o, p_plan_year: y });
    const e = ok(r, 'open'); if (e) return e;
    state.rev = r.data?.plan_revision_id; return { ok: Boolean(state.rev), detail: `revision_number=${r.data?.revision_number}` };
  });
  await step('open-revision-replay-is-idempotent', async () => {
    const r = await t.call('maker', 'phoenix_central_needs_open_manual_plan_revision', { p_organization_id: o, p_plan_year: y });
    const e = ok(r, 'replay'); if (e) return e;
    return { ok: r.data?.plan_revision_id === state.rev && r.data?.idempotent_replay === true };
  });
  await step('checker-cannot-open-or-write', async () => {
    const r1 = await t.call('checker', 'phoenix_central_needs_open_manual_plan_revision', { p_organization_id: o, p_plan_year: y + 1 });
    const r2 = await t.call('checker', 'phoenix_central_needs_add_manual_need_line', line(state, b, 'checker-try', '5', randomUUID(), null));
    return { ok: refused(r1) && refused(r2), detail: `open=${code(r1)} add=${code(r2)}` };
  });

  const key1 = randomUUID();
  await step('add-line', async () => {
    const r = await t.call('maker', 'phoenix_central_needs_add_manual_need_line', line(state, b, 'acceptance add', '100', key1, null));
    const e = ok(r, 'add'); if (e) return e;
    state.ev1 = r.data?.event_id; return { ok: Boolean(state.ev1) && r.data?.event_seq === 1 && r.data?.idempotent_replay !== true, detail: `seq=${r.data?.event_seq}` };
  });
  await step('add-line-replay-same-key', async () => {
    const r = await t.call('maker', 'phoenix_central_needs_add_manual_need_line', line(state, b, 'acceptance add', '100', key1, null));
    const e = ok(r, 'replay'); if (e) return e;
    return { ok: r.data?.idempotent_replay === true && r.data?.event_id === state.ev1 };
  });
  await step('invalid-quantity-refused', async () => {
    const bad = [];
    for (const q of ['-5', '1e3', '007', '1.50', ' 5', '٥']) if (!refused(await t.call('maker', 'phoenix_central_needs_add_manual_need_line', line(state, b, 'bad qty', q, randomUUID(), null, state.itemB)))) bad.push(q);
    return { ok: bad.length === 0, detail: bad.length ? `accepted: ${bad.join(',')}` : '6 forms refused' };
  });
  await step('correct-line-with-token', async () => {
    const r = await t.call('maker', 'phoenix_central_needs_correct_manual_need_line', { ...line(state, b, 'acceptance correct', '120', randomUUID(), state.ev1) });
    const e = ok(r, 'correct'); if (e) return e;
    state.ev2 = r.data?.event_id; return { ok: Boolean(state.ev2) && r.data?.event_seq === 2, detail: `seq=${r.data?.event_seq}` };
  });
  await step('stale-token-refused', async () => {
    const r = await t.call('maker', 'phoenix_central_needs_correct_manual_need_line', line(state, b, 'stale', '130', randomUUID(), state.ev1));
    return { ok: refused(r), detail: code(r) };
  });
  await step('events-history', async () => {
    const r = await t.call('maker', 'phoenix_central_needs_list_manual_need_events', { p_plan_revision_id: state.rev });
    const e = ok(r, 'events'); if (e) return e;
    const rows = Array.isArray(r.data) ? r.data : [];
    return { ok: rows.length === 2 && rows.map((x) => x.quantity_text).join(',') === '100,120', detail: `${rows.length} events: ${rows.map((x) => x.quantity_text).join(',')}` };
  });
  await step('checker-sees-history-read-only', async () => {
    const r = await t.call('checker', 'phoenix_central_needs_list_manual_need_events', { p_plan_revision_id: state.rev });
    const e = ok(r, 'checker events'); if (e) return e;
    return { ok: Array.isArray(r.data) && r.data.length === 2 };
  });

  // ---- governed material registration (maker requests, a DIFFERENT person reviews) ----
  const mat = (name) => ({ p_organization_id: o, p_scientific_name: name, p_name_ar: null, p_trade_name: null, p_strength: '10 mg', p_dosage_form: 'tablet', p_unit: 'box', p_barcode: null, p_note: 'R1 acceptance', p_provenance_kind: 'manual_typed', p_provenance: {}, p_plan_revision_id: null, p_idempotency_key: randomUUID() });
  await step('material-draft-update-submit', async () => {
    const d = await t.call('maker', 'phoenix_central_needs_create_material_request_draft', mat(`R1-ACC-NEWSUBSTANCE-ALPHA-${y}`));
    const e = ok(d, 'draft'); if (e) return e;
    state.req = d.data?.request_id; state.reqV = d.data?.version;
    const u = await t.call('maker', 'phoenix_central_needs_update_material_request_draft', { p_request_id: state.req, p_expected_version: state.reqV, p_scientific_name: `R1-ACC-NEWSUBSTANCE-ALPHA-${y}`, p_name_ar: null, p_trade_name: null, p_strength: '20 mg', p_dosage_form: 'tablet', p_unit: 'box', p_barcode: null, p_note: 'R1 acceptance (edited)' });
    const e2 = ok(u, 'update'); if (e2) return e2;
    const s = await t.call('maker', 'phoenix_central_needs_submit_material_request', { p_request_id: state.req, p_expected_version: u.data?.version });
    const e3 = ok(s, 'submit'); if (e3) return e3;
    state.reqV = s.data?.version; return { ok: s.data?.status === 'submitted', detail: `status=${s.data?.status}` };
  });
  await step('requester-cannot-review-own-request', async () => {
    const r = await t.call('maker', 'phoenix_central_needs_start_material_review', { p_request_id: state.req, p_expected_version: state.reqV });
    return { ok: refused(r), detail: code(r) };
  });
  await step('checker-reviews-and-approves-new', async () => {
    const s = await t.call('checker', 'phoenix_central_needs_start_material_review', { p_request_id: state.req, p_expected_version: state.reqV });
    const e = ok(s, 'start review'); if (e) return e;
    const c = await t.call('checker', 'phoenix_central_needs_material_request_candidates', { p_request_id: state.req });
    const e2 = ok(c, 'candidates'); if (e2) return e2;
    const strong = (Array.isArray(c.data) ? c.data : []).filter((x) => x.grade === 'strong');
    if (strong.length) return { ok: false, detail: `unexpected strong duplicate candidate(s): ${strong.length}` };
    const ack = (Array.isArray(c.data) ? c.data : []).map((x) => x.central_item_id);
    const a = await t.call('checker', 'phoenix_central_needs_approve_new_material', { p_request_id: state.req, p_expected_version: s.data?.version, p_acknowledged_candidates: ack, p_note: 'R1 acceptance approve' });
    const e3 = ok(a, 'approve new'); if (e3) return e3;
    state.newItem = a.data?.central_item_id; return { ok: a.data?.status === 'approved_new' && Boolean(state.newItem), detail: `status=${a.data?.status}` };
  });
  await step('approved-request-links-to-open-draft', async () => {
    const r = await t.call('maker', 'phoenix_central_needs_link_material_request_to_draft', { p_request_id: state.req, p_plan_revision_id: state.rev });
    const e = ok(r, 'link'); if (e) return e;
    return { ok: r.data?.central_item_id === state.newItem, detail: 'linked to the new catalogue item' };
  });
  await step('material-reject-path', async () => {
    const d = await t.call('maker', 'phoenix_central_needs_create_material_request_draft', mat(`R1-ACC-REJECT-BETA-${y}`));
    const e = ok(d, 'draft'); if (e) return e;
    const s = await t.call('maker', 'phoenix_central_needs_submit_material_request', { p_request_id: d.data?.request_id, p_expected_version: d.data?.version });
    const e2 = ok(s, 'submit'); if (e2) return e2;
    const st = await t.call('checker', 'phoenix_central_needs_start_material_review', { p_request_id: d.data?.request_id, p_expected_version: s.data?.version });
    const e3 = ok(st, 'start'); if (e3) return e3;
    const rj = await t.call('checker', 'phoenix_central_needs_reject_material_request', { p_request_id: d.data?.request_id, p_expected_version: st.data?.version, p_reason: 'R1 acceptance reject' });
    const e4 = ok(rj, 'reject'); if (e4) return e4;
    return { ok: rj.data?.status === 'rejected' };
  });

  // ---- scope gating ----
  await step('pharmacy-authority-only', async () => {
    const r = await t.call('maker', 'phoenix_central_needs_open_manual_plan_revision', { p_organization_id: b, p_plan_year: y });
    const r2 = await t.call('maker', 'phoenix_central_needs_open_manual_plan_revision', { p_organization_id: randomUUID(), p_plan_year: y });
    return { ok: refused(r) && refused(r2), detail: `beneficiary=${code(r)} unknown=${code(r2)}` };
  });

  // ---- maker/checker over the plan revision ----
  await step('readiness-is-server-computed', async () => {
    const r = await t.call('maker', 'phoenix_central_needs_review_readiness', { p_plan_revision_id: state.rev });
    const e = ok(r, 'readiness'); if (e) return e;
    state.ready = r.data?.ready === true; state.blockers = (r.data?.blockers ?? []).map((x) => x.blocker);
    return { ok: typeof r.data?.ready === 'boolean', detail: `ready=${state.ready} blockers=${state.blockers.join('|') || 'none'}` };
  });
  await step('submit-by-maker', async () => {
    const r = await t.call('maker', 'phoenix_central_needs_submit_revision', { p_plan_revision_id: state.rev });
    const e = ok(r, 'submit revision'); if (e) return e;
    return true;
  });
  await step('maker-cannot-approve-own-revision', async () => {
    const r = await t.call('maker', 'phoenix_central_needs_approve_revision', { p_plan_revision_id: state.rev });
    return { ok: refused(r), detail: code(r) };
  });
  await step('checker-approves', async () => {
    const r = await t.call('checker', 'phoenix_central_needs_approve_revision', { p_plan_revision_id: state.rev });
    const e = ok(r, 'approve'); if (e) return e;
    return true;
  });
  await step('approved-revision-is-frozen', async () => {
    const r = await t.call('maker', 'phoenix_central_needs_add_manual_need_line', line(state, b, 'after approve', '7', randomUUID(), null, state.itemB));
    return { ok: refused(r), detail: code(r) };
  });

  const failed = steps.filter((s) => !s.ok);
  return { pass: failed.length === 0, total: steps.length, failed: failed.length, steps };
}

function line(state, beneficiaryId, reason, quantity, key, expectedLast, item = state.itemA) {
  return { p_plan_revision_id: state.rev, p_beneficiary_organization_id: beneficiaryId, p_central_item_id: item, p_target_warehouse_id: null, p_quantity_text: quantity, p_reason: reason, p_idempotency_key: key, p_expected_last_event_id: expectedLast, p_reference: null };
}
