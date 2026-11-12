#!/usr/bin/env python3
"""Assert the audit-gate spec cannot pass for the wrong reason.

The spec pins a real property (the report is ungated, the insights panel is), but a
browser suite is unable to notice that its own harness has stopped exercising the code
under test. This suite already lost that ability once: the first draft parked its
fixture route on `https://fixture.invalid`, which the deployed preview's
`Content-Security-Policy` refuses *before* any route is consulted. The spec therefore
passed on a headerless local server and failed on the preview, which serves the header.

So `e2e/negative-control.py` serves a copy of this checkout over HTTP with the
committed `staticwebapp.config.json` `globalHeaders` applied — the condition the defect
only appeared under — and this check keeps the three things that make the argument
sound from being edited away:

  1. the spec derives its fixture base from the served config rather than inventing a
     host the CSP may refuse;
  2. it asserts the configured base is reachable before asserting anything about the
     gate, so a CSP refusal fails with its own message instead of as "Failed to fetch";
  3. the control script exists and still serves the real CSP header, still has a
     gated mode, and still carries the fail-closed token stripping.

It is deliberately textual: the property is "these mechanisms are still present", which
is a property of the source rather than of any one run. The behavioural evidence is the
recorded run outputs in ACCEPTANCE.md and, on demand, `e2e/negative-control.py` itself.

Usage:
    python3 tools/audit_gate_wiring_check.py [--root .]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SPEC = Path("e2e/audit-gate.spec.js")
CONTROL = Path("e2e/negative-control.py")

# (needle, message) — live code the spec must keep.
SPEC_REQUIRED = [
    ('const INSIGHTS = /\\/api\\/audit\\/insights$/',
     "the spec no longer matches the insights endpoint by path"),
    ("await route.fetch()",
     "the spec no longer reads the served config.js before overriding it"),
    ("window.WANTNOT_API_BASE",
     "the spec no longer reads the environment's API base back"),
    ("must be reachable from this origin",
     "the spec lost its reachability precondition — a CSP refusal would again "
     "surface only as an unexplained 'Failed to fetch'"),
    ("the valid-address click reached the fixture route",
     "the spec lost the assertion that its fixture route actually fired"),
]

# (needle, message) — the control must keep what makes it an argument.
CONTROL_REQUIRED = [
    ('config.get("globalHeaders")',
     "the control no longer applies the committed globalHeaders"),
    ("Content-Security-Policy",
     "the control no longer serves the CSP header (the whole point)"),
    ('parser.add_argument("--gate"',
     "the control lost its gated mode"),
    ("survived the rewrite",
     "the control lost its fail-closed token stripping"),
]

# The defect itself: an invented fixture host the served CSP may refuse.
DEFECTS = [
    ("fixture.invalid",
     "the spec invents a fixture host — the served CSP can refuse it before any "
     "route is consulted, which is exactly the defect this check exists for"),
    ("access-control-allow-origin",
     "the spec carries CORS response headers again; measured as not load-bearing "
     "under route interception, so they assert nothing"),
]


def is_comment(line: str) -> bool:
    stripped = line.strip()
    return (stripped.startswith("//") or stripped.startswith("*")
            or stripped.startswith("/*"))


def check(root: Path) -> list[str]:
    problems: list[str] = []

    spec_path = root / SPEC
    control_path = root / CONTROL

    if not spec_path.is_file():
        return [f"{SPEC} is missing"]
    if not control_path.is_file():
        problems.append(f"{CONTROL} is missing (the negative control cannot run)")
    else:
        control = control_path.read_text(encoding="utf-8")
        for needle, message in CONTROL_REQUIRED:
            if needle not in control:
                problems.append(f"control: {message} ({needle!r} not found)")

    spec = spec_path.read_text(encoding="utf-8")
    for needle, message in SPEC_REQUIRED:
        if needle not in spec:
            problems.append(f"spec: {message} ({needle!r} not found)")

    # Comments name the old defect to explain it; only live code counts.
    for number, line in enumerate(spec.splitlines(), 1):
        if is_comment(line):
            continue
        for needle, message in DEFECTS:
            if needle in line:
                problems.append(f"spec line {number}: {message}")
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
    print("audit-gate spec derives its fixture base from the served config and asserts "
          "reachability (negative control wired)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
