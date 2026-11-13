#!/usr/bin/env bash
# Local gate — the same checks the deploy workflow runs, runnable offline.
#
# `deploy.yml` gates a deploy on: catalog drift, the crawler files, browser/
# backend parity, and the rendered contrast/browser suite. Those are all here,
# plus the analytics suites, so a change can be cleared before it is pushed
# instead of only in CI.
#
# The analytics suites run in both places on purpose:
#
#   tools/analytics_hook_test.cjs   the hook's contract in a vm, no browser —
#                                   runs on every invocation, so inertness is
#                                   never only a browser-job property;
#   tools/analytics_csp_test.py     the CSP grant through the real tool;
#   e2e/analytics.spec.js           the same contract in a real browser, against
#                                   a deploy checkout served WITH its CSP, plus
#                                   the wiring and the consent banner.
#
# Usage:
#   bash tools/check_all.sh              # everything (needs node_modules)
#   bash tools/check_all.sh --no-browser # skip Playwright (no browser binary)
#   bash tools/check_all.sh --offline    # add the DNS-blackholed browser proof
#
# Exit 0 means every check passed. A missing dependency is a FAILURE, not a
# skip: a gate that quietly omits a check reads the same as one that passed it.
#
# --offline is separate from the default run because it launches Chromium with
# `--host-resolver-rules`, which is a property of the runner rather than of the
# change under test. It is the same suite plus e2e/offline-control.check.js, a
# positive control proving external DNS really is blocked (without it, "runs
# offline" could be a blackhole that silently does nothing).

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

PYTHON="${AUDIT_TEST_PYTHON:-python3}"
BROWSER=1
OFFLINE=0
for arg in "$@"; do
  case "$arg" in
    --no-browser) BROWSER=0 ;;
    --offline) OFFLINE=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

pass=0
fail=0
failed_names=()

run() {
  local name="$1"; shift
  printf '\n── %s\n' "$name"
  if "$@"; then
    pass=$((pass + 1))
    printf 'PASS %s\n' "$name"
  else
    fail=$((fail + 1))
    failed_names+=("$name")
    printf 'FAIL %s\n' "$name" >&2
  fi
}

# 1. Catalog drift — skus.json is the single source for the generated files.
run "catalog drift" "$PYTHON" tools/sync_catalog.py --check

# 2. Crawler files — the audit origin must serve robots.txt and sitemap.xml as
#    files, not the SPA index.
run "crawler files" "$PYTHON" tools/robots_check.py

# 2b. Social-preview metadata (#7) — a share card renders from these tags, and a
#     relative og:image or a missing og:url is invisible in a browser.
run "social metadata" "$PYTHON" tools/social_meta_check.py

# 3. Browser/backend parity — the free audit must not quote a figure the
#    backend would contradict.
run "parity" "$PYTHON" tools/parity_check.py

# 4. Analytics hook contract, no browser.
if command -v node >/dev/null 2>&1; then
  run "analytics hook (offline)" node tools/analytics_hook_test.cjs
else
  fail=$((fail + 1)); failed_names+=("analytics hook (offline): node not found")
  printf 'FAIL analytics hook: node not found\n' >&2
fi

# 5. Analytics CSP grant, through the real tool.
run "analytics CSP" "$PYTHON" tools/analytics_csp_test.py

# 6. The committed CSP must match the committed config.js. With no site id that
#    means it carries no analytics origin at all: the grant is a deploy-time
#    derivation, so a committed origin would ship a widened CSP to every build,
#    including the inert ones.
run "committed CSP matches the shipped config" "$PYTHON" tools/analytics_csp.py --root . --verify

# 7. The analytics spec must run against a SERVED CSP HEADER, not a static
#    server that sends none. If a configured case ever goes back to stubbing
#    config.js on an unheadered origin, the launch misconfiguration this card
#    exists to catch (site id set, grant never derived) would pass here and be
#    refused in production.
run "analytics spec runs against a served CSP" "$PYTHON" tools/analytics_wiring_check.py --root .

# 7b. The audit-gate spec must derive its fixture base from the SERVED config and
#     assert that base is reachable. That suite already passed for the wrong reason
#     once: its fixture route sat on an invented host the preview's CSP refuses
#     before any route is consulted, so it was green locally and red on the
#     preview. The negative control (e2e/negative-control.py) serves this checkout
#     with the committed globalHeaders; this keeps the mechanisms in place.
run "audit-gate spec derives its base from the served CSP" "$PYTHON" tools/audit_gate_wiring_check.py --root .

# 8. The browser suites.
if [ "$BROWSER" -eq 1 ]; then
  if [ -d node_modules/@playwright/test ]; then
    run "browser suites (contrast + analytics)" npx playwright test
    if [ "$OFFLINE" -eq 1 ]; then
      # Same suites under a DNS blackhole, plus the control that proves the
      # blackhole is in force. Evidence that nothing reaches a provider, not a
      # property of the change — hence opt-in.
      run "browser suites, offline proof (DNS blackholed)" \
        npx playwright test --config=tools/playwright.offline.config.js
    fi
  else
    fail=$((fail + 1))
    failed_names+=("browser suites: node_modules missing (npm ci)")
    printf 'FAIL browser suites: node_modules missing — run npm ci\n' >&2
  fi
else
  printf '\n-- browser suites skipped by --no-browser\n'
fi

printf '\n════════════════════════════════════════\n'
printf '%d passed, %d failed\n' "$pass" "$fail"
if [ "$fail" -ne 0 ]; then
  printf 'FAILED: %s\n' "${failed_names[*]}" >&2
  printf 'FAILURES ABOVE\n'
  exit 1
fi
printf 'ALL LOCAL CHECKS PASSED\n'
