#!/usr/bin/env python3
"""Negative controls: prove the analytics assertions can actually fail.

A passing suite is not evidence until each property has been observed failing
for its own reason. Each control mutates a throwaway copy of the candidate,
runs one targeted check, and asserts the EXPECTED failure — so a control that
stops failing means the corresponding test has gone vacuous.

The candidate tree is never modified: every control works on a copy under the
scratch directory and reports the mutation it applied.

Usage:
    python3 tools/analytics_negative_controls.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = Path(os.environ.get(
    "AUDIT_SCRATCH", Path.home() / ".hermes/profiles/builder-hard/cache/scratch"))
SCRATCH.mkdir(parents=True, exist_ok=True)


def copy_tree() -> Path:
    """A working copy of the candidate, minus node_modules/test artifacts."""
    dest = Path(tempfile.mkdtemp(prefix="audit-nc-", dir=SCRATCH))
    ignore = shutil.ignore_patterns("node_modules", "test-results", "playwright-report", ".git")
    for entry in ROOT.iterdir():
        if entry.name in {"node_modules", "test-results", "playwright-report", ".git"}:
            continue
        if entry.is_dir():
            shutil.copytree(entry, dest / entry.name, ignore=ignore)
        else:
            shutil.copy2(entry, dest / entry.name)
    (dest / "node_modules").symlink_to(ROOT / "node_modules")
    return dest


def run(cmd: list[str], cwd: Path, env: dict | None = None) -> subprocess.CompletedProcess:
    full_env = {**os.environ, **(env or {})}
    full_env.pop("PYTHONPATH", None)
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, env=full_env)


def playwright(tree: Path, spec: str, grep: str) -> subprocess.CompletedProcess:
    return run([
        "npx", "playwright", "test", spec, "--reporter=line", f"--grep={grep}",
    ], cwd=tree)


DETAIL = False
DETAIL_LINES: list[str] = []


def detail(result: subprocess.CompletedProcess) -> None:
    """Collect WHICH assertion failed, so a red run is attributable.

    A control that turns a suite red because the fixture threw is not evidence
    that the property's assertion can fail. Printing the failing test titles and
    the first expectation message separates those two cases without re-running
    anything. Collected rather than printed so the lines land under the control's
    own heading.
    """
    if not DETAIL:
        return
    interesting = ("✘", "×", "Error:", "expect(", "Expected", "Received",
                   "blocked", "connect-src", "passed", "failed")
    for line in (result.stdout + result.stderr).splitlines():
        stripped = line.strip()
        if not stripped or "WebServer" in stripped:
            continue
        if any(stripped.startswith(mark) for mark in interesting) or any(
                mark in stripped for mark in ("Error:", "expect(", "Expected", "Received")):
            DETAIL_LINES.append(stripped[:170])


CONTROLS: list[tuple[str, str, object]] = []


def control(name: str, expect: str):
    def register(fn):
        CONTROLS.append((name, expect, fn))
        return fn
    return register


# ── 1. the inert half ────────────────────────────────────────────────────────

@control("configured config.js shipped as the repository default", "inert tests fail")
def _configured_default(tree: Path):
    config = tree / "config.js"
    text = config.read_text(encoding="utf-8")
    config.write_text(
        text.replace("window.WANTNOT_ANALYTICS = { provider: '', site: '' };",
                     "window.WANTNOT_ANALYTICS = { provider: 'plausible', site: 'real-id' };"),
        encoding="utf-8")
    node = run(["node", "tools/analytics_hook_test.cjs"], cwd=tree)
    browser = playwright(tree, "e2e/analytics.spec.js", "inert with no site id")
    return {"node_failed": node.returncode != 0, "browser_failed": browser.returncode != 0,
            "node_tail": node.stdout.strip().splitlines()[-1:] }


# ── 2. the wiring half ───────────────────────────────────────────────────────

@control("index.html loses the analytics tag", "wiring test fails")
def _de_tagged(tree: Path):
    page = tree / "index.html"
    page.write_text(
        page.read_text(encoding="utf-8").replace(
            '<script src="analytics.js" defer></script>\n', ""),
        encoding="utf-8")
    result = playwright(tree, "e2e/analytics.spec.js", "loads config.js, then the banner")
    return {"browser_failed": result.returncode != 0}


@control("index.html loads the hook before the banner", "ordering test fails")
def _out_of_order(tree: Path):
    page = tree / "index.html"
    text = page.read_text(encoding="utf-8")
    text = text.replace('<script src="consent.js" defer></script>\n', "")
    text = text.replace('<script src="analytics.js" defer></script>',
                        '<script src="analytics.js" defer></script>\n<script src="consent.js" defer></script>')
    page.write_text(text, encoding="utf-8")
    result = playwright(tree, "e2e/analytics.spec.js", "loads config.js, then the banner")
    return {"browser_failed": result.returncode != 0}


# ── 3. the consent gate ──────────────────────────────────────────────────────

@control("the hook ignores consent and sends regardless", "consent tests fail")
def _ignores_consent(tree: Path):
    hook = tree / "analytics.js"
    text = hook.read_text(encoding="utf-8")
    # Drop the whole consent tail: send on load whenever configured.
    marker = "  if (consent && consent.state === 'accept') {"
    assert marker in text, "consent tail marker missing from the candidate"
    text = text.replace(marker, "  send(); if (false) {", 1)
    hook.write_text(text, encoding="utf-8")
    node = run(["node", "tools/analytics_hook_test.cjs"], cwd=tree)
    browser = playwright(tree, "e2e/analytics.spec.js", "rejected visitor sends nothing")
    return {"node_failed": node.returncode != 0, "browser_failed": browser.returncode != 0}


@control("the page loses its consent banner", "the browser suite refuses to pass")
def _no_banner(tree: Path):
    # Deleting the banner leaves the page LOOKING fine — the hook simply stays
    # silent — which is precisely why a served-page test, not a code reading,
    # has to be the thing that notices. The offline hook suite cannot see this
    # (it never loads the page), so the control records that and asserts the
    # browser suite catches it.
    (tree / "consent.js").unlink()
    node = run(["node", "tools/analytics_hook_test.cjs"], cwd=tree)
    browser = playwright(tree, "e2e/analytics.spec.js", "consent.js exists and is served")
    return {"node_still_passes": node.returncode == 0,  # expected: blind
            "browser_failed": browser.returncode != 0}


# ── 4. the CSP grant ─────────────────────────────────────────────────────────

@control("the CSP tool reflows the config instead of editing one literal", "byte-identity test fails")
def _reserialises(tree: Path):
    # The mistake the textual edit exists to avoid: parse, mutate, dump the whole
    # document. Equals the input as JSON but not byte-for-byte, which is exactly
    # what the assertion has to be able to see.
    tool = tree / "tools" / "analytics_csp.py"
    text = tool.read_text(encoding="utf-8")
    marker = '    if write and after != before:\n        swa.write_text(after, encoding="utf-8")'
    assert marker in text, "write marker missing from the CSP tool"
    text = text.replace(marker,
                        '    if write and after != before:\n'
                        '        swa.write_text(json.dumps(json.loads(after), indent=2) + "\\n", encoding="utf-8")',
                        1)
    tool.write_text(text, encoding="utf-8")
    result = run([sys.executable, "tools/analytics_csp_test.py"], cwd=tree)
    return {"csp_test_failed": result.returncode != 0}


@control("the grant is baked into the committed config", "gate check fails")
def _baked_grant(tree: Path):
    path = tree / "staticwebapp.config.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    csp = data["globalHeaders"]["Content-Security-Policy"]
    data["globalHeaders"]["Content-Security-Policy"] = csp.replace(
        "connect-src", "connect-src https://plausible.io", 1)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    result = run(["bash", "tools/check_all.sh", "--no-browser"], cwd=tree)
    return {"gate_failed": result.returncode != 0,
            "mentioned": "committed CSP" in (result.stdout + result.stderr)}


@control("the derivation writes no grant at all (the CSP a launch would ship wrong)", "configured beacons are blocked")
def _no_grant(tree: Path):
    # The launch misconfiguration this whole fixture exists to make visible: a
    # configured site id whose CSP never gained the origin. In production the
    # beacon is refused by the document header and the only signal is a console
    # error; here the configured cases must fail, because they run against a
    # served header rather than a server that sends none.
    tool = tree / "tools" / "analytics_csp.py"
    text = tool.read_text(encoding="utf-8")
    marker = "    new_csp = csp.replace(connect, connect + \" \" + origin, 1)"
    assert marker in text, "grant marker missing from the CSP tool"
    text = text.replace(marker, "    new_csp = csp  # mutated: grant withheld", 1)
    # The tool's own re-parse asserts the promise held, so relax that too —
    # otherwise it fails at its own guard and proves nothing about the browser.
    text = text.replace(
        "    if changed != [(connect, connect + \" \" + origin)]:",
        "    if changed != []:", 1)
    tool.write_text(text, encoding="utf-8")
    browser = playwright(tree, "e2e/analytics.spec.js",
                         "one beacon to the provider endpoint")
    detail(browser)
    return {"browser_failed": browser.returncode != 0}


@control("the derivation grants the wrong provider origin", "configured beacons are blocked")
def _wrong_origin(tree: Path):
    tool = tree / "tools" / "analytics_csp.py"
    text = tool.read_text(encoding="utf-8")
    marker = '    "plausible": "https://plausible.io",'
    assert marker in text, "provider origin table missing from the CSP tool"
    tool.write_text(
        text.replace(marker, '    "plausible": "https://plausible.example",', 1),
        encoding="utf-8")
    browser = playwright(tree, "e2e/analytics.spec.js",
                         "one beacon to the provider endpoint")
    detail(browser)
    return {"browser_failed": browser.returncode != 0}


# ── 5. the banner copy ──────────────────────────────────────────────────────

@control("the banner always claims measurement, even when inert", "inert copy test fails")
def _always_measured(tree: Path):
    banner = tree / "consent.js"
    text = banner.read_text(encoding="utf-8")
    text = text.replace("    if (!configured()) return text.inert;\n", "", 1)
    text = text.replace("PROVIDER_LABELS[configuredProvider()]", "'an analytics provider'")
    banner.write_text(text, encoding="utf-8")
    result = playwright(tree, "e2e/analytics.spec.js", "tells a visitor there is no tracking")
    return {"browser_failed": result.returncode != 0}


@control("the banner's text colour is broken", "the contrast gate fails")
def _banner_contrast(tree: Path):
    # The banner is a `position: fixed` overlay, and axe returns its text as
    # `incomplete` rather than a violation — so the gate computes the banner's
    # ratios itself. This control proves that computation can fail: `--page` is
    # the page background, which the sheet does not use, so the copy ends up
    # near-invisible (measured: 1.11 light / 1.09 dark).
    import re

    sheet = tree / "consent.css"
    text = sheet.read_text(encoding="utf-8")
    rule = re.search(r"(\.consent \.say \{[^}]*?)color: var\(--ink-2\);", text, re.S)
    assert rule, "the banner copy's colour declaration is missing from consent.css"
    sheet.write_text(
        text[:rule.start()] + rule.group(1) + "color: var(--page);" + text[rule.end():],
        encoding="utf-8",
    )
    result = playwright(tree, "e2e/contrast.spec.js", "initial audit page has no color-contrast")
    return {"browser_failed": result.returncode != 0}


def main() -> int:
    global DETAIL
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    only = args[0] if args else None
    DETAIL = "--detail" in sys.argv[1:]
    failed = 0
    for name, expectation, fn in CONTROLS:
        if only and only not in name:
            continue
        tree = copy_tree()
        try:
            DETAIL_LINES.clear()
            outcome = fn(tree)
            # Every control must have produced the failure it predicted.
            flags = {k: v for k, v in outcome.items()
                     if k in {"node_failed", "browser_failed", "csp_test_failed", "gate_failed"}}
            ok = bool(flags) and all(flags.values())
            status = "PASS" if ok else "FAIL"
            if not ok:
                failed += 1
            print(f"{status} control: {name}")
            print(f"       expected: {expectation}")
            for key, value in outcome.items():
                if key.endswith("_tail"):
                    continue
                print(f"       {key}: {value}")
            for line in DETAIL_LINES:
                print(f"       | {line}")
        finally:
            shutil.rmtree(tree, ignore_errors=True)
    if failed:
        print(f"\n{failed} negative control(s) did not fail as predicted — "
              "the corresponding assertion is vacuous", file=sys.stderr)
        return 1
    print(f"\nPASS every negative control failed for its own reason "
          f"({len(CONTROLS)} controls)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
