#!/usr/bin/env python3
"""Apply the analytics connect-src grant to a DEPLOY checkout, or prove it inert.

The audit page's analytics hook (`analytics.js`) POSTs one pageview to a
provider endpoint. A configured site id therefore needs exactly one origin in
the CSP's `connect-src`, and an unconfigured one must change nothing at all.

Why this is a tool and not a committed edit: `staticwebapp.config.json` is the
file Azure serves headers from, and the shipped state has no analytics. Editing
it by hand at launch would make "inert" a promise about what someone remembered
to revert. Instead the grant is derived from the packaged `config.js` at deploy
time, so:

  * no site id                 -> this tool writes nothing; the deployed CSP is
                                  byte-identical to the committed one;
  * site id + known provider    -> exactly one token is inserted into the one
                                  `connect-src` directive, every other byte of
                                  the file untouched;
  * site id + unknown provider  -> refuses, because shipping no grant means the
                                  beacon is blocked in production with no error
                                  anyone is watching.

`script-src` is never touched: the beacon is a POST, not a vendor tag, so no new
script origin and no new inline hash is involved. That is the whole point of the
beacon over a vendor tag, and this tool cannot widen it even if asked.

The transform is textual on purpose. `json.dumps` reflows the file (the
`navigationFallback.exclude` array is one line in the committed file and seven
in a canonical dump), so a reserialise-and-write would silently reformat a
config this change has no business editing. Only the CSP's JSON string literal
is replaced, and the result is re-parsed and asserted before anything is written.

Usage:
    python3 tools/analytics_csp.py --root .            # report, change nothing
    python3 tools/analytics_csp.py --root . --write    # apply to that checkout
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

CONFIG_NAME = "config.js"
SWA_NAME = "staticwebapp.config.json"

# Origin per candidate provider, matching PROVIDERS in analytics.js. This is the
# third place a provider name appears (hook, banner copy, CSP) and the reason
# the banner copy keys on "a site id is set" instead of on provider identity:
# a list that drifts here must not be able to make the page claim it measures
# nothing while it measures.
ANALYTICS_ORIGINS = {
    "plausible": "https://plausible.io",
    "fathom": "https://cdn.usefathom.com",
}

# `window.WANTNOT_ANALYTICS = { provider: 'plausible', site: 'abc' };`
ANALYTICS_OBJECT = re.compile(r"WANTNOT_ANALYTICS\s*=\s*\{([^}]*)\}", re.S)
ANALYTICS_FIELD = re.compile(r"\b(provider|site)\s*:\s*[\"']([^\"']*)[\"']")


class Refused(Exception):
    """A configured state this tool must not silently ship."""


def analytics_config(config_js: Path) -> tuple[str, str]:
    """(provider, site) from ``config.js``; ('', '') when there is none."""
    if not config_js.is_file():
        return "", ""
    block = ANALYTICS_OBJECT.search(config_js.read_text(encoding="utf-8"))
    if not block:
        return "", ""
    fields = dict(ANALYTICS_FIELD.findall(block.group(1)))
    return fields.get("provider", "").strip(), fields.get("site", "").strip()


def analytics_origin(config_js: Path) -> str | None:
    """The one CSP origin a configured hook needs, or None when inert.

    None means "change nothing": no config.js, no site id, or a provider this
    build does not know. The caller decides whether an unknown provider is a
    quiet no-op or a refusal.
    """
    provider, site = analytics_config(config_js)
    if not site:
        return None
    return ANALYTICS_ORIGINS.get(provider)


def _directives(csp: str) -> list[str]:
    return [part.strip() for part in csp.split(";") if part.strip()]


def grant(text: str, origin: str) -> str:
    """Insert ``origin`` into connect-src, preserving every other byte."""
    config = json.loads(text)
    headers = config.get("globalHeaders") or {}
    csp = headers.get("Content-Security-Policy")
    if not csp:
        raise Refused("CSP header is absent; cannot grant an analytics origin")

    directives = _directives(csp)
    connect = next((d for d in directives if d.split()[0] == "connect-src"), None)
    if connect is None:
        # A connect-src-less CSP falls back to default-src, which the visitor's
        # browser applies to the beacon. Granting into the wrong directive would
        # look successful and block the request.
        raise Refused("CSP has no connect-src directive; cannot grant analytics origin")

    tokens = connect.split()
    if origin in tokens[1:]:
        return text  # already granted: idempotent, byte-identical

    if origin in csp.split():
        raise Refused(
            f"{origin} already appears in the CSP outside connect-src; "
            "refusing to guess which directive was meant"
        )

    new_csp = csp.replace(connect, connect + " " + origin, 1)
    literal = json.dumps(csp)
    if text.count(literal) != 1:
        raise Refused(
            "the CSP string is not unique in the config file; "
            "refusing a textual edit that could hit the wrong literal"
        )

    updated = text.replace(literal, json.dumps(new_csp), 1)

    # Re-parse and assert the promise: one directive, one new token, nothing
    # else moved.
    reparsed = json.loads(updated)
    new_directives = _directives(reparsed["globalHeaders"]["Content-Security-Policy"])
    if len(new_directives) != len(directives):
        raise Refused("the edit changed the directive count")
    changed = [(a, b) for a, b in zip(directives, new_directives) if a != b]
    if changed != [(connect, connect + " " + origin)]:
        raise Refused(f"the edit changed more than connect-src: {changed}")
    script_before = [d for d in directives if d.startswith("script-src")]
    script_after = [d for d in new_directives if d.startswith("script-src")]
    if script_before != script_after:
        raise Refused("script-src changed; the beacon must never widen it")
    return updated


def granted(text: str, origin: str) -> bool:
    """True when the CSP in ``text`` already allows ``origin`` in connect-src."""
    csp = json.loads(text).get("globalHeaders", {}).get("Content-Security-Policy") or ""
    connect = next((d for d in _directives(csp) if d.split()[0] == "connect-src"), None)
    return connect is not None and origin in connect.split()[1:]


def run(root: Path, write: bool) -> dict:
    """Apply (or describe) the grant for one checkout. Returns a report dict."""
    config_js = root / CONFIG_NAME
    swa = root / SWA_NAME
    report = {
        "config_js": str(config_js),
        "staticwebapp_config": str(swa),
        "provider": "",
        "site_configured": False,
        "origin": None,
        # `applied` means the file on disk now carries the grant. `bytes_changed`
        # means this invocation would write (dry run) or did write — separating
        # them keeps a `--json` probe from reporting a change it never made.
        "applied": False,
        "bytes_changed": False,
    }
    provider, site = analytics_config(config_js)
    report["provider"] = provider
    report["site_configured"] = bool(site)

    if not site:
        # The shipped state. Nothing is read from, or written to, the CSP.
        return report

    origin = ANALYTICS_ORIGINS.get(provider)
    if origin is None:
        raise Refused(
            f"analytics site id is set but provider {provider!r} is not a known "
            f"provider ({', '.join(sorted(ANALYTICS_ORIGINS))}); no CSP grant would "
            "be shipped, so this configuration can never send a beacon — name a "
            "provider or clear the site id"
        )
    report["origin"] = origin

    if not swa.is_file():
        raise Refused(f"{SWA_NAME} is missing from {root}")

    before = swa.read_text(encoding="utf-8")
    after = grant(before, origin)
    report["bytes_changed"] = after != before
    # On disk, before this invocation: a dry run must never report a change it
    # did not make, and a repeat run must still report the grant as present.
    report["applied"] = granted(before, origin)
    if write and after != before:
        swa.write_text(after, encoding="utf-8")
    return report


def verify(root: Path) -> tuple[bool, str]:
    """Check the config on disk against the config.js it was derived from.

    This is the post-write assertion: it reads what will actually be deployed,
    rather than trusting that the write step did what it said. It runs in the
    deploy job after `--write`, and in the gate against a clean checkout where it
    doubles as the "inert really is inert" proof.
    """
    provider, site = analytics_config(root / CONFIG_NAME)
    swa = root / SWA_NAME
    if not swa.is_file():
        return False, f"{SWA_NAME} is missing from {root}"
    text = swa.read_text(encoding="utf-8")

    if not site:
        leaked = [origin for origin in ANALYTICS_ORIGINS.values() if origin in text]
        if leaked:
            return False, (
                "no analytics site id is configured, but the CSP carries "
                f"{leaked[0]} — the grant must not be committed"
            )
        return True, "analytics inert: no site id, CSP carries no analytics origin"

    origin = ANALYTICS_ORIGINS.get(provider)
    if origin is None:
        return False, f"site id set with unknown provider {provider!r}"
    if not granted(text, origin):
        return False, f"site id set but {origin} is not in the connect-src directive"
    csp = json.loads(text)["globalHeaders"]["Content-Security-Policy"]
    others = [o for o in ANALYTICS_ORIGINS.values() if o != origin and o in csp]
    if others:
        return False, f"more than one analytics origin is granted: {origin} and {others[0]}"
    return True, f"analytics configured: {origin} in connect-src ({provider})"


def verify_wiring(root: Path) -> tuple[bool, str]:
    """Check index.html's script order: config.js, then banner, then hook.

    A tag pointing at a missing file, or a hook loaded before the banner that
    answers for it, both read as "wired" in a diff and fail only in a browser.
    This is the static form of that assertion, so the deploy job catches it
    before the bytes are published.
    """
    page = root / "index.html"
    if not page.is_file():
        return False, f"index.html is missing from {root}"
    html = page.read_text(encoding="utf-8")
    positions: dict[str, int] = {}
    for name in ("config.js", "consent.js", "analytics.js"):
        found = re.search(
            r"<script[^>]+src=[\"']" + re.escape(name) + r"[\"']", html, re.I)
        if not found:
            return False, f"index.html does not load {name}"
        positions[name] = found.start()
    if not positions["config.js"] < positions["consent.js"]:
        return False, "index.html loads consent.js before config.js"
    if not positions["consent.js"] < positions["analytics.js"]:
        return False, (
            "index.html loads analytics.js before consent.js — the hook would read "
            "a consent seam that does not exist yet"
        )
    if len(re.findall(r"analytics\.js", html)) != 1:
        return False, "index.html references analytics.js more than once"
    if len(re.findall(r"consent\.js", html)) != 1:
        return False, "index.html references consent.js more than once"
    return True, "index.html wiring verified: config.js -> consent.js -> analytics.js"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                    formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=Path("."),
                        help="checkout whose config.js and staticwebapp.config.json to read")
    parser.add_argument("--write", action="store_true",
                        help="apply the grant in place (deploy checkouts only)")
    parser.add_argument("--verify", action="store_true",
                        help="assert the config on disk matches the configured state; non-zero on mismatch")
    parser.add_argument("--verify-wiring", action="store_true",
                        help="assert index.html loads config.js, then consent.js, then analytics.js")
    parser.add_argument("--json", action="store_true", help="emit the report as JSON")
    args = parser.parse_args(argv)

    try:
        if args.verify:
            ok, message = verify(args.root)
            if not ok:
                print(f"::error::analytics CSP: {message}", file=sys.stderr)
                return 1
            print(message)
            return 0
        if args.verify_wiring:
            ok, message = verify_wiring(args.root)
            if not ok:
                print(f"::error::analytics wiring: {message}", file=sys.stderr)
                return 1
            print(message)
            return 0
        report = run(args.root, args.write)
    except Refused as error:
        print(f"::error::analytics CSP: {error}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(report, indent=2))
    elif not report["site_configured"]:
        print("analytics inert: no site id, CSP left untouched")
    elif report["bytes_changed"]:
        verb = "granted" if args.write else "would grant"
        print(f"analytics {verb} {report['origin']} in connect-src "
              f"({report['provider']})")
    else:
        print(f"analytics already granted: {report['origin']} ({report['provider']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
