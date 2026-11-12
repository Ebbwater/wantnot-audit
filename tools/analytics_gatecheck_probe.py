#!/usr/bin/env python3
"""Prove the gate's "served CSP" static check can fail.

The check added to tools/check_all.sh is an assertion in its own right: it
fails if the analytics spec goes back to configuring analytics by route-stubbing
config.js, or if the fixtures that serve the CSP header stop being wired. An
assertion nobody has seen fail is uncalibrated, so this probe applies the
regression to a throwaway copy of the spec and requires the check to reject it.
"""
from __future__ import annotations

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
    dest = Path(tempfile.mkdtemp(prefix="audit-gatecheck-", dir=SCRATCH))
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


def run_gate_check(tree: Path) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    return subprocess.run(
        [sys.executable, "tools/analytics_wiring_check.py", "--root", "."],
        cwd=tree, capture_output=True, text=True, env=env,
    )


def regression_stub_config(tree: Path) -> None:
    """The exact defect: configure analytics by stubbing config.js."""
    spec = tree / "e2e" / "analytics.spec.js"
    text = spec.read_text(encoding="utf-8")
    marker = '      await serveOffline(page);\n      const sent = await captureBeacons(page);\n'
    assert marker in text, "appended-stub anchor missing"
    spec.write_text(
        text.replace(
            marker,
            marker + '      await page.route("**/config.js", (route) => route.fulfill({\n'
                     '        contentType: "text/javascript",\n'
                     '        body: configWith("plausible", TEST_SITE),\n'
                     '      }));\n',
            1,
        ),
        encoding="utf-8")


def regression_fixture_drops_header(tree: Path) -> None:
    """The fixture stops emitting the CSP header."""
    fixture = tree / "e2e" / "fixtures" / "analytics-site.js"
    text = fixture.read_text(encoding="utf-8")
    marker = 'headers["Content-Security-Policy"] = csp;'
    assert marker in text, "header marker missing"
    fixture.write_text(text.replace(marker, "// header removed", 1), encoding="utf-8")


CASES = [
    ("spec goes back to stubbing config.js", regression_stub_config, False),
    ("fixture stops serving the CSP header", regression_fixture_drops_header, False),
    ("unmodified candidate", None, True),
]


def main() -> int:
    failed = 0
    for name, mutate, should_pass in CASES:
        tree = copy_tree()
        try:
            if mutate:
                mutate(tree)
            result = run_gate_check(tree)
            ok = (result.returncode == 0) == should_pass
            if not ok:
                failed += 1
            print(f"{'PASS' if ok else 'FAIL'} probe: {name} "
                  f"(gate exit {result.returncode}, expected "
                  f"{'0' if should_pass else 'non-zero'})")
            for line in (result.stdout + result.stderr).splitlines():
                if "::error::" in line or "analytics spec runs against" in line:
                    print(f"       {line.strip()[:160]}")
        finally:
            shutil.rmtree(tree, ignore_errors=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
