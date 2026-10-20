// Token-aware SQL/PLpgSQL comparison (no database). Whitespace and comments are not significant; everything else is:
// identifiers/keywords compare case-insensitively (unquoted), quoted identifiers and string/dollar-quoted literals compare EXACTLY, numbers and each
// operator/punctuation token compare exactly. So `a b` and `ab` differ, `'x'` and `'X'` differ, `"Id"` and id differ - unlike a whitespace-stripped diff.
const OPS3 = ['->>', '#>>', '<->'];
const OPS2 = [':=', '<>', '!=', '<=', '>=', '||', '::', '->', '#>', '@>', '<@', '=>', '..', '~*', '!~', '&&'];

export function tokenizeSql(src) {
  const t = []; let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && src[i + 1] === '-') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { let d = 1; i += 2; while (i < n && d > 0) { if (src[i] === '/' && src[i + 1] === '*') { d++; i += 2; } else if (src[i] === '*' && src[i + 1] === '/') { d--; i += 2; } else i++; } continue; }
    if (c === "'" || ((c === 'E' || c === 'e') && src[i + 1] === "'")) {
      const esc = c !== "'"; let j = i + (esc ? 2 : 1); let v = '';
      while (j < n) { if (esc && src[j] === '\\') { v += src[j] + (src[j + 1] ?? ''); j += 2; continue; } if (src[j] === "'") { if (src[j + 1] === "'") { v += "''"; j += 2; continue; } break; } v += src[j++]; }
      t.push({ k: 'str', v }); i = j + 1; continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 80));
      if (m) { const tag = m[0]; const end = src.indexOf(tag, i + tag.length); if (end < 0) throw new Error('unterminated dollar quote'); t.push({ k: 'dollar', v: tag + src.slice(i + tag.length, end) + tag }); i = end + tag.length; continue; }
    }
    if (c === '"') { let j = i + 1; let v = ''; while (j < n) { if (src[j] === '"') { if (src[j + 1] === '"') { v += '""'; j += 2; continue; } break; } v += src[j++]; } t.push({ k: 'qid', v }); i = j + 1; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) { const m = /^(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)/.exec(src.slice(i)); t.push({ k: 'num', v: m[0] }); i += m[0].length; continue; }
    if (/[A-Za-z_\u0080-￿]/.test(c)) { let j = i + 1; while (j < n && /[A-Za-z0-9_$\u0080-￿]/.test(src[j])) j++; t.push({ k: 'id', v: src.slice(i, j).toLowerCase() }); i = j; continue; }
    const s3 = src.slice(i, i + 3), s2 = src.slice(i, i + 2);
    if (OPS3.includes(s3)) { t.push({ k: 'op', v: s3 }); i += 3; continue; }
    if (OPS2.includes(s2)) { t.push({ k: 'op', v: s2 }); i += 2; continue; }
    t.push({ k: 'op', v: c }); i++;
  }
  return t;
}

/** @returns {{ equal: boolean, count: number, firstDifference: null | { index: number, a: object|null, b: object|null } }} */
export function compareSqlTokens(a, b) {
  const A = tokenizeSql(a), B = tokenizeSql(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    if (!A[i] || !B[i] || A[i].k !== B[i].k || A[i].v !== B[i].v) return { equal: false, count: Math.min(A.length, B.length), firstDifference: { index: i, a: A[i] ?? null, b: B[i] ?? null } };
  }
  return { equal: true, count: A.length, firstDifference: null };
}
