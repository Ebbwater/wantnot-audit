#!/usr/bin/env python3
"""Offline regressions for tools/analytics_csp.py.

The CSP grant is the difference between "the beacon works" and "the beacon is
blocked by a header nobody watches", so it needs assertions that run without a
browser: this file drives the real tool against a scratch copy of the committed
config and reads the result back.

REGRESSION names mark the properties that must not return.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "tools" / "analytics_csp.py"
SWA = "staticwebapp.config.json"

TESTS: list[tuple[str, object]] = []


def check(name):
    def register(fn):
        TESTS.append((name, fn))
        return fn
    return register


def config_js(provider: str, site: str) -> str:
    return (
        "window.WANTNOT_AUDIT_CLIENT_ID = 'test-client-id';\n"
        "window.WANTNOT_API_BASE = 'https://func-wantnot-4dc52f.azurewebsites.net';\n"
        f"window.WANTNOT_ANALYTICS = {{ provider: '{provider}', site: '{site}' }};\n"
    )


class Scratch:
    """A throwaway checkout holding the committed config plus a config.js."""

    def __init__(self, body: str):
        self.dir = Path(tempfile.mkdtemp(prefix="audit-csp-test-"))
        shutil.copyfile(ROOT / SWA, self.dir / SWA)
        (self.dir / "config.js").write_text(body, encoding="utf-8")

    def path(self) -> Path:
        return self.dir / SWA

    def before(self) -> str:
        return self.path().read_text(encoding="utf-8")

    def run(self, *extra: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(TOOL), "--root", str(self.dir), *extra],
            capture_output=True, text=True, check=False,
        )

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        shutil.rmtree(self.dir, ignore_errors=True)
        return False


def csp(text: str) -> str:
    return json.loads(text)["globalHeaders"]["Content-Security-Policy"]


def directives(text: str) -> list[str]:
    return [part.strip() for part in csp(text).split(";") if part.strip()]


def connect(text: str) -> str:
    return next(d for d in directives(text) if d.startswith("connect-src"))


# ── the shipped state ────────────────────────────────────────────────────────

@check("REGRESSION an empty site id leaves the config byte-identical")
def _empty_site():
    with Scratch(config_js("plausible", "")) as s:
        before = s.before()
        result = s.run("--write")
        assert result.returncode == 0, result.stderr
        assert s.path().read_text(encoding="utf-8") == before
        # And it is still the committed file, not a reflowed equivalent.
        assert s.path().read_bytes() == (ROOT / SWA).read_bytes()


@check("REGRESSION a missing config.js is inert rather than an error")
def _missing_config():
    with Scratch("") as s:
        (s.dir / "config.js").unlink()
        before = s.before()
        result = s.run("--write")
        assert result.returncode == 0, result.stderr
        assert s.path().read_text(encoding="utf-8") == before


@check("REGRESSION config.js with no WANTNOT_ANALYTICS block is inert")
def _no_block():
    with Scratch("window.WANTNOT_AUDIT_CLIENT_ID = 'x';\n") as s:
        before = s.before()
        assert s.run("--write").returncode == 0
        assert s.path().read_text(encoding="utf-8") == before


# ── the configured state ─────────────────────────────────────────────────────

@check("REGRESSION a site id changes only the connect-src literal, byte for byte")
def _one_literal():
    # The grant is applied by textual edit precisely so an unrelated reflow
    # cannot ride along. Directive-level equality would not see a reformat, so
    # this asserts the ONLY change is the inserted origin.
    with Scratch(config_js("plausible", "test-site-id")) as s:
        before = s.before()
        assert s.run("--write").returncode == 0
        after = s.path().read_text(encoding="utf-8")
        origin = "https://plausible.io"
        # Removing the inserted token must reproduce the input exactly.
        assert after != before
        assert after.count(origin) == 1, after.count(origin)
        assert after.replace(" " + origin, "", 1) == before


@check("REGRESSION a site id adds exactly one origin to connect-src and nothing else")
def _one_origin():
    with Scratch(config_js("plausible", "test-site-id")) as s:
        before = s.before()
        result = s.run("--write")
        assert result.returncode == 0, result.stderr
        after = s.path().read_text(encoding="utf-8")

        assert directives(after) and len(directives(after)) == len(directives(before))
        changed = [d for d, b in zip(directives(after), directives(before)) if d != b]
        assert changed == [connect(before) + " https://plausible.io"], changed

        # script-src is the directive a vendor tag would have widened.
        script = lambda t: next(d for d in directives(t) if d.startswith("script-src"))
        assert script(after) == script(before)

        # One exact origin: no path, no subdomain wildcard, no scheme wildcard.
        assert "plausible.io/api" not in connect(after)
        assert "*.plausible.io" not in connect(after)
        assert (after.count("*")) == before.count("*")


@check("the provider line selects the origin, and only that origin")
def _provider_selects():
    with Scratch(config_js("fathom", "test-site-id")) as s:
        assert s.run("--write").returncode == 0
        after = s.path().read_text(encoding="utf-8")
        assert "https://cdn.usefathom.com" in connect(after)
        assert "plausible.io" not in after


@check("REGRESSION re-running the tool does not add the origin twice")
def _idempotent():
    with Scratch(config_js("plausible", "test-site-id")) as s:
        assert s.run("--write").returncode == 0
        once = s.path().read_text(encoding="utf-8")
        assert s.run("--write").returncode == 0
        twice = s.path().read_text(encoding="utf-8")
        assert once == twice
        assert once.count("https://plausible.io") == 1


@check("REGRESSION without --write the tool reports but changes nothing")
def _dry_run():
    with Scratch(config_js("plausible", "test-site-id")) as s:
        before = s.before()
        result = s.run("--json")
        assert result.returncode == 0, result.stderr
        assert s.path().read_text(encoding="utf-8") == before
        report = json.loads(result.stdout)
        assert report["site_configured"] is True
        assert report["origin"] == "https://plausible.io"
        assert report["bytes_changed"] is True, "a configured run must report the pending change"
        assert report["applied"] is False, "a dry run must not claim it applied"


# ── --verify: the post-write assertion ──────────────────────────────────────

@check("REGRESSION --verify passes on the shipped checkout (inert, no origin)")
def _verify_inert():
    result = subprocess.run(
        [sys.executable, str(TOOL), "--root", str(ROOT), "--verify"],
        capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "inert" in result.stdout


@check("REGRESSION --verify fails when the committed CSP carries a grant with no site id")
def _verify_leaked():
    with Scratch(config_js("plausible", "")) as s:
        path = s.path()
        config = json.loads(path.read_text(encoding="utf-8"))
        csp = config["globalHeaders"]["Content-Security-Policy"]
        config["globalHeaders"]["Content-Security-Policy"] = csp.replace(
            "connect-src", "connect-src https://plausible.io", 1)
        path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
        result = s.run("--verify")
        assert result.returncode != 0
        assert "must not be committed" in result.stderr


@check("--verify passes after a configured grant is applied, and fails before it")
def _verify_configured():
    with Scratch(config_js("plausible", "test-site-id")) as s:
        # Before the write: the site id is set but the grant is absent.
        before = s.run("--verify")
        assert before.returncode != 0, "verify accepted a configured site with no grant"
        assert "not in the connect-src" in before.stderr

        assert s.run("--write").returncode == 0
        after = s.run("--verify")
        assert after.returncode == 0, after.stderr
        assert "configured" in after.stdout


@check("--verify rejects two analytics origins granted at once")
def _verify_two_origins():
    with Scratch(config_js("plausible", "test-site-id")) as s:
        path = s.path()
        config = json.loads(path.read_text(encoding="utf-8"))
        csp = config["globalHeaders"]["Content-Security-Policy"]
        config["globalHeaders"]["Content-Security-Policy"] = csp.replace(
            "connect-src", "connect-src https://cdn.usefathom.com", 1)
        path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
        assert s.run("--write").returncode == 0
        result = s.run("--verify")
        assert result.returncode != 0
        assert "more than one analytics origin" in result.stderr


# ── refusals ─────────────────────────────────────────────────────────────────

@check("REGRESSION a site id with an unknown provider refuses and changes nothing")
def _unknown_provider():
    with Scratch(config_js("gtag", "test-site-id")) as s:
        before = s.before()
        result = s.run("--write")
        # Shipping no grant would block the beacon in production with the only
        # signal a console error no operator is watching.
        assert result.returncode != 0
        assert "unknown provider" in result.stderr or "not a known provider" in result.stderr
        assert s.path().read_text(encoding="utf-8") == before


@check("REGRESSION a CSP with no connect-src refuses instead of granting elsewhere")
def _no_connect_src():
    with Scratch(config_js("plausible", "test-site-id")) as s:
        config = json.loads(s.path().read_text(encoding="utf-8"))
        config["globalHeaders"]["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self' 'unsafe-inline'"
        )
        s.path().write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
        before = s.before()
        result = s.run("--write")
        assert result.returncode != 0
        assert "connect-src" in result.stderr
        assert s.path().read_text(encoding="utf-8") == before


@check("a CSP with no header at all refuses")
def _no_csp():
    with Scratch(config_js("plausible", "test-site-id")) as s:
        config = json.loads(s.path().read_text(encoding="utf-8"))
        del config["globalHeaders"]["Content-Security-Policy"]
        s.path().write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
        before = s.before()
        assert s.run("--write").returncode != 0
        assert s.path().read_text(encoding="utf-8") == before


@check("whitespace-only site value is inert")
def _whitespace_site():
    with Scratch(config_js("plausible", "   ")) as s:
        before = s.before()
        assert s.run("--write").returncode == 0
        assert s.path().read_text(encoding="utf-8") == before


@check("REGRESSION a site id with a blank provider refuses rather than shipping a dead beacon")
def _blank_provider():
    # The hook trims a blank provider to '' and stays inert, so this config can
    # never send. The deploy step must say so instead of shipping it quietly —
    # a hook that can never fire is the exact defect this work exists to avoid.
    with Scratch(config_js("  ", "test-site-id")) as s:
        before = s.before()
        result = s.run("--write")
        assert result.returncode != 0
        assert s.path().read_text(encoding="utf-8") == before


def main() -> int:
    failed = 0
    for name, fn in TESTS:
        try:
            fn()
            print(f"PASS {name}")
        except AssertionError as error:
            failed += 1
            print(f"FAIL {name}\n{error}", file=sys.stderr)
        except Exception as error:  # noqa: BLE001 - report, do not hide
            failed += 1
            print(f"FAIL {name}\n{type(error).__name__}: {error}", file=sys.stderr)
    if failed:
        print(f"\n{failed} of {len(TESTS)} analytics CSP regressions failed", file=sys.stderr)
        return 1
    print(f"\nPASS every analytics CSP regression holds ({len(TESTS)} cases)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
