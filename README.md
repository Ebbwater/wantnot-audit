# WantNot — Instant Audit (browser-only)

Free, **browser-only** Microsoft 365 licence waste audit. Sign in as a Global Reader or Global Admin, get a costed breakdown in about a minute — or import CSV exports from the Microsoft 365 admin centre with no consent at all. **Nothing is stored, anywhere**; directory data goes from Microsoft Graph to this tab and no further.

Live on **`https://audit.wantnot.ebbwater.net/`** (SWA `swa-wantnot-audit`,
`brave-ground-0ca79031e.7.azurestaticapps.net`). The full WantNot product lives at
`https://wantnot.ebbwater.net/`; this repo is the free audit only (private product
repo `kylernunan/wantnot`). Product navigation, brand and privacy links use that
current origin. The audit's legacy canonical metadata remains part of the separate
canonical/DNS cutover tracked in WantNot #158; this link repair does not flip it.

**Trust model:** delegated OIDC with PKCE, public client, no secret, three **read-only** delegated scopes. See [Scopes](#scopes) and [Privacy](#privacy).

---

## What it finds

| Kind | Confidence | Basis |
|---|---|---|
| `unassigned_seats` | Certain | `prepaidUnits.enabled − consumedUnits`, collated per SKU |
| `disabled_user` | Certain | `accountEnabled = false` holding a paid licence |
| `deleted_user` | Certain | Soft-deleted account still holding a paid licence |
| `never_signed_in` | Likely | No sign-in ever, created >45 days ago |
| `dormant_user` | Likely | No interactive *or* non-interactive sign-in in 90 days |
| `redundant_sku` | Review | Service-plan set is a strict subset of another held SKU |

`downgrade_candidate` (bundle → cheaper SKU when only Exchange/Teams/etc. is used) is **backend-only** and intentionally not in this audit — see [Known limitations](#known-limitations).

Every finding carries its evidence (sku, seats, dollar figure, UPN) and a stable fingerprint `kind|SKU|upn` (or `kind|SKU` for unassigned seats).

---

## Two ways in — same engine, different trade-offs

- **Live (delegated):** `Organization.Read.All` + `User.Read.All` + `AuditLog.Read.All` via PKCE. Calls `graph.microsoft.com` directly from the browser (`index.html:271` `MSAL_CDNS`).
- **Import:** no consent, no sign-in. Drop the two admin-centre CSVs on the page; parsing happens in the tab (`index.html:513` `eachCsvRow`), only allowlisted columns are retained (`readProjected`), object ids are never read. Service plans are absent from every export, so `redundant_sku` degrades correctly (skipped when plan sets are empty) and the report says so.

---

CSV imports accept `.csv` names (case-insensitive) with CSV, plain-text, Excel CSV or absent browser MIME metadata. Both selected files are validated before either is read; unsupported types show an inline error. File metadata is only an admission check: the existing CSV/header parser and projected-column allowlists still determine supported content. No upload endpoint is involved.

## Scopes

| Delegated scope | Why |
|---|---|
| `Organization.Read.All` | `GET /subscribedSkus` — purchased seat counts |
| `User.Read.All` | Users, `assignedLicenses`, `accountEnabled`, `department` |
| `AuditLog.Read.All` | `signInActivity` for dormancy (also needs a directory role like Global/Reports Reader) |
| `User.Read` | Sign the admin in |

No `Reports.Read.All` on the audit app — downgrade detection is deferred. No write scopes.

---

## Privacy

- Analysis runs in the browser (`audit_logic.js:1` — port of the backend `shared/analyzer.py` logic, checked by `tools/parity_runner.mjs`).
- No backend, no database, no queue. Closing the tab ends the session (`sessionStorage` only).
- CSV import keeps only the columns a finding needs (`USER_COLS` + `LIC_COLS` inside `index.html:693`/`index.html:781`); `ignored` columns are dropped and the raw row is discarded. Object ids are never read — findings are keyed on UPN + SKU.
- The audit never fetches `id` — only `displayName,userPrincipalName,accountEnabled,createdDateTime,assignedLicenses,department` plus `signInActivity` when available (`index.html:439` `USER_SELECT`).

---

## Running locally

```bash
# file:// preview works except MSAL redirect (needs https origin)
python3 -m http.server 4280
# then open http://localhost:4280/

# with a real Entra app
cp config.js.example config.js
# edit WANTNOT_AUDIT_CLIENT_ID — see tools/create_audit_app.sh
```

No build step — `skip_app_build: true` in the deploy workflow.

Rendered contrast checks cover the sign-in/import page, an imported CSV report,
expanded findings, and a selected chart legend in both light and dark themes:

```bash
npm ci
npx playwright install chromium
npm run test:contrast
```

The test starts a local server with `python3`; set `AUDIT_TEST_PYTHON` to a
Python executable path if needed. Set `PREVIEW_URL` to check a deployed preview.
These checks use synthetic CSVs and require no Microsoft sign-in or customer data.
They gate deployment alongside catalog drift and analyzer parity.

## Deploying your own copy

1. Create the Entra app (delegated, public client, SPA redirect):
   ```bash
   ./tools/create_audit_app.sh          # creates WantNot Instant Audit, writes config.js locally
   # or manually: infra/05-audit-app.sh equivalent — see script header for requiredResourceAccess GUIDs
   ```
   Register your origin as SPA redirect: `https://your-host/` **and** `https://your-host/index.html` (both — MSAL derives redirect from `location.pathname` and SWA canonicalises `index.html ↔ /`).

2. Set GitHub secret `AUDIT_CLIENT_ID` to the app's client ID. The deploy workflow writes `config.js` from it at build time (forks without the secret still run parity checks — deploy just skips).

3. Push to `main` → `.github/workflows/deploy.yml` checks `tools/sync_catalog.py --check` + parity, then deploys to your Static Web App / Pages host.

---

## SKU prices & catalog

Prices are **list** (USD/user/month, annual commitment) from `skus.json:2` (snapshot of the private repo's `shared/skus.py` `CatalogVersion 2026-08`). Each entry is marked `(v)` verified or `(u)` carried-forward in the private source — the snapshot carries the same drift. A report leaning >10% on list emits a warning; enter contracted rates in the full product to make it exact.

`skus.json` is the single source for this repo. Regenerate derived files after bumping it:

```bash
python tools/sync_catalog.py          # writes catalog.js, kinds.js, palette.css
python tools/sync_catalog.py --check  # CI drift gate — fails if derived files are stale
```

Bumping prices is a PR that edits `skus.json`; derived files must be regenerated in the same PR (CI enforces).

**Nightly sync:** `.github/workflows/sync-catalog.yml` pulls `skus.json` + the parity contract from `kylernunan/wantnot@main` (04:15 UTC, after the backend's weekly catalog sync) and opens a PR on drift — derived files are regenerated and both gates run inside the sync branch before review. It needs a read-only PAT on the private repo in the `WANTNOT_SYNC_PAT` secret; forks without it skip cleanly.

---

## Parity — browser and backend agree

The contract crosses the repo boundary as two files:

- `fixtures/parity_fixtures.json` — the inputs (mirror of `tools/parity_fixtures.json` in `kylernunan/wantnot`)
- `fixtures/parity_expected.json` — the backend's outputs, generated from `shared/analyzer.py` by `tools/parity_snapshot.py` in the private repo

`tools/parity_check.py` runs the browser analyzer (`audit_logic.js`) through the fixtures (via `tools/parity_runner.mjs`) and asserts the output matches the snapshot — finding keys, seats, money, confidence, waste totals, warning semantics. A divergence would mean the free audit quotes a figure the backend would contradict — that is the credibility failure this product exists to prevent.

```bash
python tools/parity_check.py     # 30/30 assertions against the snapshot
```

A fixture or analyzer change must regenerate the snapshot in `wantnot` (`python3 tools/parity_snapshot.py`) and sync both files — the nightly workflow opens that PR automatically on drift.

Downgrade is exempt — the browser intentionally does not emit `downgrade_candidate`; the snapshot comparison tolerates that `backend-only` kind.

---

## Repository layout

```
index.html              audit shell + live Graph + CSV importer + report rendering
audit_logic.js          analysis engine (6 kinds, no downgrade)
catalog.js              generated from skus.json (SKU_CATALOG)
kinds.js                generated from skus.json (KINDS → --k1..k7)
palette.css             generated from skus.json (light + dark ramp)
sort.js                 table sorting for report tables
skus.json               snapshot of shared/skus.json (version, priceAsOf, skus, kinds, palette)
config.js               placeholder; real client ID injected at deploy from AUDIT_CLIENT_ID
config.js.example       annotated template for forks
brand/*                 proprietary — see BRAND_LICENSE.md
site.webmanifest        PWA manifest
staticwebapp.config.json SWA routing + CSP (no azurewebsites.net connect-src)
tools/
  parity_check.py       browser output vs fixtures/parity_expected.json (self-contained)
  parity_runner.mjs     browser analyzer runner for fixtures
  sync_catalog.py       skus.json → catalog.js/kinds.js/palette.css + --check
fixtures/
  parity_fixtures.json  published contract inputs (mirror of wantnot tools/parity_fixtures.json)
  parity_expected.json  backend outputs per fixture (from wantnot tools/parity_snapshot.py)
.github/workflows/
  deploy.yml            drift gate + parity vs snapshot + config guard + deploy
  sync-catalog.yml      nightly pull of skus.json + parity contract from wantnot
```

---

## Known limitations

- `downgrade_candidate` is backend-only (deferred).
- Service plans are absent from every admin-centre CSV, so `redundant_sku` cannot be detected from imports.
- Storage is `westus2` only in the full product — not relevant here (no storage).
- No SOC 2, no pen test — same posture as the full product; compliance docs live in the private repo (`kylernunan/wantnot:COMPLIANCE.md`, `STATUS.md`, `legal/`). `https://wantnot.ebbwater.net/audit` redirects to the audit origin.

---

## License

Code: **MIT** — see `LICENSE` (brand assets excluded). Brand: **proprietary** — see `BRAND_LICENSE.md`. Forks should replace `brand/*` with their own mark.

Microsoft 365 is a trademark of Microsoft. Not affiliated.
