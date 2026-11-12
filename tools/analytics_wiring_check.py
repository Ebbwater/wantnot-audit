#!/usr/bin/env python3
"""Assert the analytics browser suite runs against a SERVED CSP header.

`connect-src` is a header on the document response, not something a page can
grant itself. So a configured-site-id case written as `page.route("**/config.js")`
on a plain static server cannot exercise the launch path: the served document
keeps its inert CSP, the beacon POST is refused, and the case passes only
because there is no header to refuse it. That blind spot shipped once in
`ebbwater/wantnot` (PR #539: three "configured" cases failed on the hosting
preview and passed locally), and an earlier draft of this repository's spec had
it too.

A browser suite cannot be trusted to notice its own harness losing the header,
so this is the static check: it fails when the spec drifts back to route-stubbing
config.js for a configured case, when it stops reading the served header, when
its deploy-checkout fixture stops emitting or deriving the CSP, or when either
negative control disappears.

It is deliberately textual. The property is "the fixture and the assertions that
depend on it are still present", which is a property of the source rather than of
any single run; the behavioural evidence lives in e2e/analytics.spec.js.
`tools/analytics_gatecheck_probe.py` demonstrates this check fails on both
regressions.

Usage:
    python3 tools/analytics_wiring_check.py [--root .]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SPEC = Path("e2e/analytics.spec.js")
FIXTURE = Path("e2e/fixtures/analytics-site.js")

# (needle, message) pairs the fixture must keep.
FIXTURE_REQUIRED = [
    ('headers["Content-Security-Policy"] = csp',
     "the fixture no longer sets the CSP response header"),
    ("analytics_csp.py",
     "the fixture no longer applies the real CSP tool"),
    ("--write",
     "the fixture no longer applies the grant the way the deploy job does"),
    ("refused",
     "the fixture no longer records a refused derivation"),
]

# (needle, message) pairs the spec must keep.
SPEC_REQUIRED = [
    ("deploySite(",
     "the spec does not use the deploy-checkout fixture"),
    ('headers()["content-security-policy"]',
     "the spec never reads the served CSP header"),
    ("withoutOrigin(",
     "the spec lost its grant-removal negative control"),
    ("serveNoCsp: true",
     "the spec lost the no-CSP blindness demonstration"),
]

# The defect itself: a route stub that supplies a configured config.js.
DEFECT = 'page.route("**/config.js"'


def is_comment(line: str) -> bool:
    stripped = line.strip()
    return stripped.startswith("//") or stripped.startswith("*") or stripped.startswith("/*")


def check(root: Path) -> list[str]:
    """Every problem found, or an empty list when the harness is intact."""
    problems: list[str] = []

    spec_path = root / SPEC
    fixture_path = root / FIXTURE

    if not spec_path.is_file():
        return [f"{SPEC} is missing"]
    spec = spec_path.read_text(encoding="utf-8")

    if not fixture_path.is_file():
        problems.append(f"{FIXTURE} is missing (the spec cannot serve a CSP header without it)")
    else:
        fixture = fixture_path.read_text(encoding="utf-8")
        for needle, message in FIXTURE_REQUIRED:
            if needle not in fixture:
                problems.append(f"fixture: {message} ({needle!r} not found)")

    for needle, message in SPEC_REQUIRED:
        if needle not in spec:
            problems.append(f"spec: {message} ({needle!r} not found)")

    # Comments discuss the defect by name — only live code counts. A stub for
    # the *banner* is legitimate (the missing-seam case uses one); a stub for
    # config.js supplying a site id is the defect.
    for number, line in enumerate(spec.splitlines(), 1):
        if is_comment(line):
            continue
        if DEFECT in line:
            problems.append(
                f"spec line {number}: analytics is configured by route-stubbing "
                "config.js — that cannot exercise the document CSP")
            break

    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=Path("."),
                        help="checkout whose e2e/ directory to inspect")
    args = parser.parse_args(argv)

    problems = check(args.root)
    if problems:
        for problem in problems:
            print(f"::error::{problem}", file=sys.stderr)
        return 1
    print("analytics configured cases run against a served CSP header "
          "(fixture wired, negative controls present)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
