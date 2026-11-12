# Analytics on the audit page (GTM W3 follow-up)

The audit page (`https://audit.wantnot.ebbwater.net/`) is served from **this**
repository, not from `ebbwater/wantnot`. The marketing site's GTM W3 work wired
a provider-neutral beacon into its nine marketing pages and deliberately left
the audit page alone, because `dashboard/audit.html` there is a 301 stub and
carries no consent banner — a hook wired to it could never fire. This is the
wiring for the page that actually renders.

The code path is in place and **inert**. Nothing is measured today. This
document is the switch, the consent surface, and the legal work that has to
happen with it. It is a launch procedure, not a record that analytics is live.

Owner decision 2026-11-11: no provider is chosen, so the shipped state must be
provably silent rather than merely untested.

## What ships inert

| Piece | Shipped state |
|---|---|
| `config.js` | `window.WANTNOT_ANALYTICS = { provider: '', site: '' };` |
| `analytics.js` | Loads on the audit page and does nothing |
| `consent.js` / `consent.css` | The banner renders, and its copy says there is no tracking |
| `staticwebapp.config.json` | **Unchanged.** No analytics origin appears in the CSP |
| Privacy/terms pages | **Unchanged.** No policy text was added by this work |

Inert means all of: no beacon sent, no vendor global defined, page DOM
untouched. `window.WantNotAnalytics.state === 'inert'` is the observable form of
that, and `e2e/analytics.spec.js` asserts it in a real browser with consent
accepted — the one answer that would otherwise permit a send.

## Why a beacon rather than a vendor tag

The two candidates expect different tag attributes (`data-domain` for Plausible,
`data-site` for Fathom) and each needs its own CDN origin under `script-src`.
Shipping "the analytics hook" as a vendor tag therefore means shipping one
vendor's payload under the other vendor's name, before the owner has chosen
either. A `POST` carries the same pageview with no third-party code in the page,
and the CSP cost is one `connect-src` origin rather than a widened `script-src`
with a new inline hash.

The reported URL is `location.origin + location.pathname`. Query and fragment
are dropped deliberately: this page accepts `?tenant=<guid>` for pinning sign-in
to one directory, and a beacon must not turn a customer's tenant id into a third
party's log line.

## The consent surface — decided, not defaulted

The audit page had **no consent banner**. It is one page whose entire promise is
"nothing is stored", so nothing non-essential ever needed an answer. That is
precisely the state the marketing work called out as a wiring mistake
(`state === 'no-consent-seam'`): a beacon added to a page that never asks can
never fire and never says why.

**Decision: the banner ships with the hook.** `consent.js` provides the same
seam the marketing pages expose — `window.WantNotConsent = { state, onChange }`
— and `analytics.js` sends only when `state === 'accept'`. The alternative
(recording that this page needs no consent) was available and is rejected here:

- The page sets no cookie today, but a *configured* beacon is still a
  non-essential outbound request that identifies a visitor's page view to a
  third party. "It stores nothing" answers the cookie question, not the
  question of whether the visitor was asked.
- A page-level exemption would be a second consent model in the product, and
  the two would drift: one page asking, one deciding for itself. Reviewers can
  check "does the beacon gate on the seam" mechanically; they cannot check that
  an exemption argument still holds two changes later.
- A banner on the audit page costs nothing real. It is `position: fixed`, so it
  adds no layout shift to the audit form, and Accept/Reject are equal-weight
  buttons with no nudge.

The banner is `consent.js` + `consent.css`, loaded `defer` **before**
`analytics.js` (also `defer`), so the seam exists before the hook reads it.
`e2e/analytics.spec.js` asserts that order and the one-tag-each invariant.

### The banner copy is computed, not remembered

The marketing banner hard-codes "No analytics, no advertising cookie, no
tracking between sites", and that repo's launch doc warns the sentence becomes
false the moment a provider is configured — a launch-time edit someone has to
remember. Here the sentence is selected from `window.WANTNOT_ANALYTICS`, the
same object the hook reads:

| Config | Banner body |
|---|---|
| `site: ''` (shipped) | containment wording: "No advertising cookie, no tracking between sites" |
| known provider + site id | measurement wording: one anonymous page view, page address without query string, no cookie, nothing from the directory or the account |
| unknown provider + site id | containment wording — the hook refuses an unknown provider, so no beacon can leave |

Consent obtained under a false description is not consent, so the description is
derived from the thing being described. The provider table in `consent.js` is
asserted equal to `PROVIDERS` in `analytics.js` by the browser spec, so the two
cannot drift apart without a failure.

The copy deliberately claims only what this page's own code does — what is sent
and what is not touched. Retention, IP truncation and country are statements
about a *provider's* published terms, not about this repository; the banner
links the privacy policy for them, and that policy must be updated before a
site id ships (below).

## The switch — one file, then the CSP

Edit `config.js` (or the deploy generator in `.github/workflows/deploy.yml`):

```js
window.WANTNOT_ANALYTICS = { provider: 'plausible', site: '<site-id>' };
```

`provider` is `'plausible'` or `'fathom'`. `site` is that provider's
site/property id. Then, **in the same release**:

1. **Confirm the endpoint and payload** in `PROVIDERS` in `analytics.js`. Both
   rows were written from the providers' documented shapes but have never been
   exercised against a live account — this work created no account and sent no
   beacon. Check `endpoint` and the `n`/`u`/`d` or `h`/`p` field names against
   current provider documentation and adjust the row if they moved.
2. **Confirm the CSP origin** in `ANALYTICS_ORIGINS` in `tools/analytics_csp.py`.
   Already present for both candidates. If the provider is a third one, add it
   there; an unknown provider makes the deploy step **fail**, because a
   configured site id with no grant ships a beacon the CSP blocks with no error
   any operator is watching.
3. **Land the privacy-policy wording.** See below.

### Why the CSP is derived at deploy time

`staticwebapp.config.json` is not edited by this work. The grant is applied to
the checked-out config **at deploy time** by `tools/analytics_csp.py`, from the
`config.js` the deploy job just wrote:

```bash
python tools/analytics_csp.py --root .            # report only
python tools/analytics_csp.py --root . --write    # apply to that checkout
```

- No site id: the tool writes nothing, and the deployed config is **byte-
  identical** to the committed one.
- Site id + known provider: exactly one token is inserted into the one
  `connect-src` directive, and the result is re-parsed and asserted (directive
  count unchanged, exactly one changed directive, `script-src` identical) before
  anything is written.
- Site id + unknown provider: refuse, non-zero exit, file untouched.

Committing the grant instead would make "inert" a promise about what someone
remembered to revert, and the tool's textual edit exists for the same reason:
`json.dumps` reflows this file (the `navigationFallback.exclude` array is one
line committed and seven in a canonical dump), so a reserialise-and-write would
reformat a config this change has no business touching.

`tools/check_all.sh` also asserts the committed CSP names no analytics origin,
so a grant can never be baked into the repository by accident.

## Privacy policy and subprocessor wording — required legal text

**Do not ship a configured provider without this.** The wording is specified in
`docs/ANALYTICS-LAUNCH.md` in `ebbwater/wantnot` (sections 1–3: the *Website
data* paragraph in `dashboard/privacy.html`, the subprocessor table changes, and
`legal/SUBPROCESSORS.md` + `legal/DPA.md:Annex III`). That document is the
source of truth for the text; this repository does not own those pages and this
work deliberately did not edit them.

Two audit-specific points that document cannot make for this repository:

- The audit page's banner links `https://wantnot.ebbwater.net/privacy`. If a
  site id ships while that page still says the site sets no analytics, the
  banner's own link contradicts the banner. Both must change in the same
  release.
- The DPA gives controllers **30 days' notice** before a sub-processor is added
  (DPA §6). Publish the notice and the objection route before the provider goes
  live, not after.

## Consent state and what it means

| state | meaning | action |
|---|---|---|
| `inert` | no site id, or no known provider — the shipped default | none; correct until launch |
| `awaiting-consent` | configured, banner shown, answer is not accept | none; this is consent working |
| `no-consent-seam` | configured with no banner | **wiring mistake** — this page can never send |
| `send-failed` | a beacon was attempted and did not go | **broken endpoint or missing CSP grant** |
| `sent` | one pageview left this page load | — |

`data-analytics="<provider>"` appears on `<html>` only in the `sent` state — a
failed send never marks the page as tracked.

## Verifying after any change

```bash
bash tools/check_all.sh                # every gate, including both analytics suites
bash tools/check_all.sh --no-browser   # without Playwright (no browser binary)
bash tools/check_all.sh --offline      # adds the DNS-blackholed browser proof

node tools/analytics_hook_test.cjs                 # hook contract, no browser
python3 tools/analytics_csp_test.py                # CSP grant through the real tool
npx playwright test e2e/analytics.spec.js          # browser: inert, configured, consent
git diff staticwebapp.config.json                  # must be empty: the grant is deploy-time
```

### The configured cases run under a SERVED CSP, and that is load-bearing

`connect-src` is a header on the **document response**, not something a page can
grant itself. `playwright.config.js` serves the page with `python3 -m http.server`,
which sends no `Content-Security-Policy` header at all:

```console
$ curl -sS -D - -o /dev/null http://127.0.0.1:8902/ | grep -ci content-security-policy
0
```

So the obvious way to test a configured site id — `page.route("**/config.js")`
with a test id — cannot exercise the launch path. The served document keeps its
inert CSP, the browser refuses the beacon POST, and the case passes only because
there is no header to refuse it. That exact blind spot shipped once in
`ebbwater/wantnot` (PR #539: three "configured" cases failed on the hosting
preview and passed locally), so an earlier draft of this spec had it too.

Every configured case here therefore runs against `e2e/fixtures/analytics-site.js`:
a copy of the served files plus the config.js the deploy job generates,
`tools/analytics_csp.py --write` applied exactly as the deploy applies it, and a
small server that emits the resulting `staticwebapp.config.json`
`globalHeaders` — including the derived CSP — as response headers, the way Azure
Static Web Apps does. Three cases make that structural:

| Case | What it proves |
|---|---|
| `one beacon … allowed by the derived CSP` (per provider) | the document really carried the derived header, that header really grants the origin, and exactly one beacon reached the wire |
| `THE DEFECT CLASS … no CSP header but blocked under the committed CSP` | the same configured build beacons **without** the header and is refused **with** it — the blindness the old harness had, reproduced |
| `NEGATIVE CONTROL: with the derived grant removed …` | same build minus the one `connect-src` token: zero beacons, one observed *attempt*, state `send-failed`, nothing marked tracked |

`tools/check_all.sh` also asserts statically that the spec still reads the
served header and still uses the fixture, so a future edit cannot quietly
reintroduce the headerless harness. `tools/analytics_gatecheck_probe.py`
demonstrates that static check fails on both regressions.

`bash tools/check_all.sh --offline` runs the same suite under Chromium with
`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`, plus
`e2e/offline-control.check.js`, a positive control requiring
`https://example.com/` to fail to resolve — otherwise a blackhole that silently
does nothing would let every suite "pass offline" for the wrong reason. Both
provider origins are fulfilled locally in the spec, so nothing reaches a vendor
either way.

`python3 tools/analytics_negative_controls.py` is review evidence rather than a
per-push gate (it drives the browser suites repeatedly, about two minutes): each
control mutates a throwaway copy of the candidate and asserts that the matching
assertion FAILS for its own reason — a configured default, a de-tagged page, a
banner loaded after the hook, a hook that ignores consent, a deleted banner, a
CSP tool that reflows the config, a grant baked into the committed file, a
derivation that writes no grant, a derivation naming the wrong origin, banner
copy that always claims measurement, and a banner whose text colour is broken.
A control that stops failing means the assertion protecting it has gone vacuous.
Add `--detail` (optionally with a name filter) to print which assertion each
control broke, so a red run is attributable to the property rather than to a
fixture that threw.

The browser spec proves both halves offline: no analytics request with an empty
site id (including after an `accept`), and exactly one beacon to the configured
provider's origin — redirected into a local fake, so no request leaves the
machine — only after consent is `accept`, never for a visitor who rejects or has
not answered. It also proves the `no-consent-seam` state by blocking the banner,
which is the only way that state is reachable in this repository.

## What this work deliberately did not do

- Did not edit any privacy policy, terms page, or `legal/` document.
- Did not create a provider account, accept vendor terms, or choose a provider.
- Did not send a single beacon to a real endpoint, or set a real site id.
- Did not touch `script-src`, and cannot: the tool refuses if it changes.
