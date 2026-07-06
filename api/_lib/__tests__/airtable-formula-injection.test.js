/**
 * M1 — Airtable filterByFormula injection (unauth-reachable via /api/member/claim
 * and api/discord.js).
 *
 * Airtable filterByFormula string literals ("...") have NO backslash escape.
 * The old sanitizer did String(v).replace(/"/g,'\\"'), which turns a`"`b into
 * a\"b — Airtable parses that as literal-backslash + literal-`"`, so the quote
 * is NOT neutralized and the attacker breaks out of the literal (cross-record
 * match / malformed AND(...) query). Our email regex permits `"`, so crafted
 * input reaches these formulas unauthenticated.
 *
 * Fix: escapeFormulaValue STRIPS both quote characters (" and '), backslashes,
 * and control chars/newlines, so nothing an attacker supplies can terminate the
 * literal. Legitimate emails (which never contain quotes) are unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  escapeFormulaValue,
  findActiveMintByEmail,
  findActiveMintByEmailAndType,
  findAnyMintByEmailAndType,
  findMemberByEmail,
  upsertMemberByEmail,
  findPaymentByTransactionId,
} from '../airtable.js';

// Capture the filterByFormula sent to Airtable so we can prove no breakout.
function mockFetchCapture(records = []) {
  const calls = [];
  const fn = vi.fn(async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      async json() { return { records }; },
      async text() { return ''; },
    };
  });
  fn.calls = calls;
  return fn;
}

function formulaFrom(url) {
  const u = new URL(url);
  return u.searchParams.get('filterByFormula');
}

const ATTACKS = [
  'a"b@x.com',
  'x" OR 1=1',
  "x' OR 1=1",
  'foo")+OR+(LOWER({Email})="admin@aurevonvc.com',
  'line\nbreak@x.com',
  'tab\tchar@x.com',
  'back\\slash@x.com',
];

describe('escapeFormulaValue', () => {
  it('strips both double and single quotes from any input', () => {
    for (const bad of ['a"b', "a'b", `a"'b`, 'x" OR 1=1', "x' OR 1=1"]) {
      const out = escapeFormulaValue(bad);
      expect(out).not.toContain('"');
      expect(out).not.toContain("'");
    }
  });

  it('strips backslashes (no \\" escape exists in Airtable formulas)', () => {
    expect(escapeFormulaValue('a\\"b')).not.toContain('\\');
    expect(escapeFormulaValue('a\\"b')).not.toContain('"');
  });

  it('strips control chars and newlines', () => {
    const out = escapeFormulaValue('a\nb\r\tc\x00d');
    expect(out).toBe('abcd');
  });

  it('leaves legitimate emails completely unchanged', () => {
    for (const good of [
      'buyer@example.com',
      'first.last+tag@sub.domain.co',
      'MixedCase@Example.COM',
      'name_with-dashes123@example-domain.io',
    ]) {
      // A normal email contains none of the stripped chars.
      expect(escapeFormulaValue(good)).toBe(good);
    }
  });
});

describe('formula-building call sites neutralize injected quotes', () => {
  beforeEach(() => { process.env.AIRTABLE_PAT = 'test_pat'; });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function assertNoBreakout(fn) {
    for (const bad of ATTACKS) {
      const capture = mockFetchCapture([]);
      vi.stubGlobal('fetch', capture);
      await fn(bad);
      const formula = formulaFrom(capture.calls[0]);
      // The double-quotes present must be ONLY the structural delimiters the
      // template hardcodes — the injected value must contribute zero quotes.
      // We prove this by extracting the value between the first ="..." pair
      // for {Email}/{Transaction ID} and confirming it holds no quote/backslash.
      const injected = extractInjectedValue(formula);
      expect(injected).not.toBeNull();
      expect(injected).not.toContain('"');
      expect(injected).not.toContain("'");
      expect(injected).not.toContain('\\');
      // And no raw control chars survived into the query.
      // eslint-disable-next-line no-control-regex
      expect(/[\x00-\x1F\x7F]/.test(injected)).toBe(false);
      // Whole-formula guard: no backslash and no stray single quote anywhere —
      // this also covers secondary literals ({NFT Type}) that carry the payload
      // in the two-field lookups, not just the first {Email} literal.
      expect(formula).not.toContain('\\');
      expect(formula).not.toContain("'");
    }
  }

  // The email/txn value is always the first `="<value>"` occurrence, and after
  // sanitization the value has no embedded quote, so the first closing `"` is
  // the true delimiter.
  function extractInjectedValue(formula) {
    const m = formula.match(/="([^"]*)"/);
    return m ? m[1] : null;
  }

  it('findActiveMintByEmail', async () => { await assertNoBreakout(findActiveMintByEmail); });
  it('findActiveMintByEmailAndType', async () => {
    await assertNoBreakout((v) => findActiveMintByEmailAndType(v, v));
  });
  it('findAnyMintByEmailAndType', async () => {
    await assertNoBreakout((v) => findAnyMintByEmailAndType(v, v));
  });
  it('findMemberByEmail', async () => { await assertNoBreakout(findMemberByEmail); });
  it('upsertMemberByEmail', async () => { await assertNoBreakout((v) => upsertMemberByEmail(v, {})); });
  it('findPaymentByTransactionId', async () => { await assertNoBreakout(findPaymentByTransactionId); });

  it('normal email produces the exact expected, unmodified filter', async () => {
    const capture = mockFetchCapture([]);
    vi.stubGlobal('fetch', capture);
    await findActiveMintByEmail('Buyer@Example.com');
    const formula = formulaFrom(capture.calls[0]);
    expect(formula).toBe(
      'AND(LOWER({Email})="buyer@example.com",OR({Mint Status}="Minted",{Mint Status}="Sent",{Mint Status}="Queued"))',
    );
  });
});
