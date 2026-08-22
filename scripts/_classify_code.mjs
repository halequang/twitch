/**
 * Classifies mail bodies with the shop's own rules and picks the code that may be
 * handed over. Reads JSON on stdin, writes JSON on stdout.
 *
 * A thin shell around classifyCode/pickLoginCode in src/lib/steamcode.js, so the
 * Python side does not carry a second copy of those patterns. That matters more here
 * than anywhere else in this repo: Steam sends the same-looking mail for signing in
 * and for changing credentials, the lists that tell them apart were built from
 * captured mail in three languages, and a Python copy drifting behind the JS would
 * not fail visibly — it would hand over a credential-change code, which is an
 * account transfer.
 *
 * Input:   {"emails":[{"subject":"...","readable":"...","code":"ABC12"}],"depth":2}
 * Output:  {"code":"ABC12","purpose":"login","depth":0,"scanned":2,
 *           "purposes":[{"subject":"...","purpose":"login","code":"ABC12"}]}
 *
 * `code` is null unless a mail was classified 'login'; `purpose` then says why not
 * ('credential_change' or 'unknown'), and both are refusals — never printed as a
 * code to use.
 */

import { CODE_SCAN_DEPTH, classifyCode, pickLoginCode } from '../src/lib/steamcode.js';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw || '{}');
} catch (err) {
  console.error(`bad input json: ${err.message}`);
  process.exit(2);
}

const emails = Array.isArray(input.emails) ? input.emails : [];
const depth = Number.isFinite(Number(input.depth)) && Number(input.depth) > 0
  ? Number(input.depth)
  : CODE_SCAN_DEPTH;

const picked = pickLoginCode(emails, depth);

console.log(
  JSON.stringify({
    code: picked.mail?.code ?? null,
    purpose: picked.purpose,
    depth: picked.depth,
    scanned: picked.scanned,
    // Per-mail verdicts, so a refusal can say which mail was refused and why
    // instead of only that nothing was served.
    purposes: emails.map((mail) => ({
      subject: mail?.subject ?? '',
      code: mail?.code ?? null,
      purpose: classifyCode(`${mail?.readable ?? ''}\n${mail?.subject ?? ''}`),
    })),
  })
);
