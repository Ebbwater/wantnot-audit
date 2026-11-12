#!/usr/bin/env python3
"""Negative control for e2e/audit-gate.spec.js.

Serves a copy of this checkout over HTTP **with the committed
`staticwebapp.config.json` `globalHeaders` applied as response headers** — i.e. the
header set the Azure Static Web App actually sends, which `python3 -m http.server`
does not. That is the condition the spec originally failed under.

Usage:
    python3 e2e/negative-control.py --gate      # serve the GATED report, expect FAIL
    python3 e2e/negative-control.py             # serve the real report, expect PASS

Prints the port on stdout so a caller can export PREVIEW_URL.
"""
import argparse
import http.server
import json
import shutil
import socketserver
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SERVED = [
    "index.html", "analytics.js", "consent.js", "consent.css", "audit_logic.js",
    "catalog.js", "kinds.js", "palette.css", "sort.js", "site.webmanifest",
    "robots.txt", "sitemap.xml", "skus.json", "staticwebapp.config.json",
    "config.js", "brand", "fixtures",
]

# The deploy-time config.js, as .github/workflows/deploy.yml writes it. A synthetic
# client id is enough to boot the page; the spec overrides it anyway.
CONFIG = """/* Generated at deploy — do not commit. */
window.WANTNOT_AUDIT_CLIENT_ID = 'audit-negative-control-client';
window.WANTNOT_API_BASE = 'https://func-wantnot-4dc52f.azurewebsites.net';
window.WANTNOT_ANALYTICS = { provider: '', site: '' };
"""

OLD = """    const r = runImport(ut, lt, label);
    lastResult = r;
    renderReport(r);"""

NEW = """    const r = runImport(ut, lt, label);
    lastResult = r;
    // NEGATIVE CONTROL: gate the report behind an email address. The spec must fail.
    if(!(window.__NEG_EMAIL||'').match(/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/)){
      throw new Error('Enter a valid work email to see your report.');
    }
    renderReport(r);"""


def build(scratch: Path, gate: bool) -> None:
    for name in SERVED:
        src = ROOT / name
        if src.exists():
            dst = scratch / name
            if src.is_dir():
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
    (scratch / "config.js").write_text(CONFIG, encoding="utf-8")
    if gate:
        index = scratch / "index.html"
        text = index.read_text(encoding="utf-8")
        if text.count(OLD) != 1:
            raise SystemExit(f"control anchor matched {text.count(OLD)} times, expected 1")
        index.write_text(text.replace(OLD, NEW), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gate", action="store_true",
                        help="serve the gated report (the negative control)")
    parser.add_argument("--strip-api-host", action="store_true",
                        help="drop the configured API host from connect-src, reproducing "
                             "the original defect (CSP refuses the page's own API base)")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()

    scratch = Path(tempfile.mkdtemp(prefix="wantnot-audit-nc-"))
    build(scratch, args.gate)

    config = json.loads((scratch / "staticwebapp.config.json").read_text(encoding="utf-8"))
    headers = dict(config.get("globalHeaders") or {})
    if "Content-Security-Policy" not in headers:
        raise SystemExit("fixture would serve no CSP; the whole point is the header")

    if args.strip_api_host:
        # The pre-fix failure in one line: the document forbids the very base config.js
        # names, so no route stub of any shape can be reached. Both the explicit host
        # AND the `*.azurewebsites.net` wildcard have to go — either one alone still
        # matches the API base, which is why stripping just the explicit entry is a
        # vacuous control (measured: the spec still passed).
        api_base = CONFIG.split("WANTNOT_API_BASE = '")[1].split("'")[0]
        scheme, host = api_base.split("//")
        # The CSP token keeps its scheme: `https://*.azurewebsites.net`, not the bare
        # wildcard. Comparing the bare form passes a substring check and then strips
        # nothing — a vacuous control that still looks successful.
        wildcard = f"{scheme}//*." + ".".join(host.split(".")[1:])
        csp = headers["Content-Security-Policy"]
        # A directive's last token carries the `;`. Compare normalised tokens or the
        # membership test silently fails to find the token it is looking for.
        tokens = {token.rstrip(";") for token in csp.split()}
        for token in (api_base, wildcard):
            if token not in tokens:
                raise SystemExit(f"{token} is not a connect-src token; nothing to strip")
        directives = [d.strip() for d in csp.split(";") if d.strip()]
        rewritten = []
        for directive in directives:
            parts = directive.split()
            if parts[0] == "connect-src":
                parts = [p for p in parts if p.rstrip(";") not in (api_base, wildcard)]
            rewritten.append(" ".join(parts))
        stripped = "; ".join(rewritten)
        # Fail closed: prove the tokens are actually gone before serving.
        for token in (api_base, wildcard):
            if token in {t.rstrip(";") for t in stripped.split()}:
                raise SystemExit(f"{token} survived the rewrite; the control would be vacuous")
        headers["Content-Security-Policy"] = stripped
        print(f"# stripped {api_base} and {wildcard} from connect-src", file=sys.stderr, flush=True)

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(scratch), **kw)

        def end_headers(self):
            for key, value in headers.items():
                self.send_header(key, value)
            super().end_headers()

        def log_message(self, format, *args):  # noqa: A002 - base signature
            pass

    with socketserver.TCPServer(("127.0.0.1", args.port), Handler) as httpd:
        port = httpd.server_address[1]
        print(f"http://127.0.0.1:{port}", flush=True)
        print(f"# serving {'GATED' if args.gate else 'real'} report from {scratch}"
              f" with {len(headers)} globalHeaders incl. CSP", file=sys.stderr, flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
