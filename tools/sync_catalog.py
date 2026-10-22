#!/usr/bin/env python3
"""Generate frontend catalog assets from skus.json single source.

WantNot Instant Audit (audit.wantnot.ebbwater.net) is static-only — no Python
runtime. skus.json is the single source for SKU names/prices, kinds, and
palette. This script renders the three generated front-end files from it and
doubles as the drift gate for CI.

    python tools/sync_catalog.py --check   # CI: verify no drift
    python tools/sync_catalog.py           # regenerate

Origin of skus.json: snapshot of shared/skus.json from the private
kylernunan/wantnot repo (shared/skus.py → shared/skus.json via
tools/generate_frontend_catalog.py). Bumping prices is a PR that updates
skus.json; this script then regenerates the derived files.

MIT License — brand assets under ./brand are NOT covered (see BRAND_LICENSE.md).
"""
import argparse
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
JSON = ROOT / "skus.json"
CATALOG_JS = ROOT / "catalog.js"
KINDS_JS = ROOT / "kinds.js"
PALETTE_CSS = ROOT / "palette.css"


def load_json():
    data = json.loads(JSON.read_text(encoding="utf-8"))
    return data


def render_catalog_js(data):
    skus = data.get("skus", {})
    version = data.get("version", "2026-08")
    # Keep SKU_CATALOG_VERSION / PRICE_AS_OF in sync with skus.json version
    lines = ["/* Generated from skus.json — do not hand-edit. Run tools/sync_catalog.py */",
             "var SKU_CATALOG = {"]
    for k, v in sorted(skus.items()):
        name, price = v[0], v[1]
        qk = f'"{k}"' if not re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', k) or "(" in k else k
        esc = name.replace("'", "\\'")
        lines.append(f"  {qk}:['{esc}',{float(price):.2f}],")
    lines.append("};")
    lines.append(f'var SKU_CATALOG_VERSION = "{version}";')
    lines.append(f'var SKU_PRICE_AS_OF = "{data.get("priceAsOf", version)}";')
    lines.append("if (typeof module !== 'undefined') module.exports = { SKU_CATALOG, SKU_CATALOG_VERSION, SKU_PRICE_AS_OF };")
    return "\n".join(lines) + "\n"


def render_kinds_js(data):
    kinds = data.get("kinds", {})
    # kinds is {kind: [label, var]} — render dual-shape _k() helper
    return ("/* Generated from skus.json — do not hand-edit. Run tools/sync_catalog.py\n"
            "   Dual shape: array [label,var] for audit.html and object {label,v} for dashboard.html. */\n"
            "function _k(label, v){ const a=[label,v]; a.label=label; a.v=v; return a; }\n"
            "var KINDS = {\n" +
            "".join(f"  {k}:_k('{v[0]}','{v[1]}'),\n" for k, v in kinds.items()) +
            "};\n"
            "var KINDS_SHARED = KINDS;\n"
            "var ORDER_SHARED = Object.keys(KINDS);\n"
            "if (typeof module !== 'undefined') module.exports = { KINDS, KINDS_SHARED, ORDER_SHARED };\n")


def render_palette_css(data):
    palette = data.get("palette", {})
    light = palette.get("light", {})
    dark = palette.get("dark", {})
    # Fallback to defaults if missing
    if not light:
        light = {"--k1": "#FF4D2E", "--k2": "#FF7038", "--k3": "#FB9440", "--k4": "#DCAA4A", "--k5": "#B3A277", "--k6": "#8F9E86", "--k7": "#6F8C9B"}
    if not dark:
        dark = {"--k1": "#FF6647", "--k2": "#FF8654", "--k3": "#FCA659", "--k4": "#E4BB65", "--k5": "#C0B08A", "--k6": "#9DAF95", "--k7": "#7F9DAD"}
    light_s = " ".join(f"{k}:{v};" for k, v in light.items())
    dark_s = " ".join(f"{k}:{v};" for k, v in dark.items())
    return (f"/* Generated from skus.json — do not hand-edit. Run tools/sync_catalog.py */\n"
            f":root{{ {light_s} }}\n"
            f"@media (prefers-color-scheme:dark){{:root{{ {dark_s} }}}}\n")


def main():
    ap = argparse.ArgumentParser(description="Sync generated frontend files from skus.json")
    ap.add_argument("--check", action="store_true", help="verify files match skus.json, exit non-zero on drift")
    args = ap.parse_args()

    if not JSON.exists():
        print(f"ERROR: {JSON} not found", file=sys.stderr)
        sys.exit(2)

    data = load_json()
    expected_catalog = render_catalog_js(data)
    expected_kinds = render_kinds_js(data)
    expected_palette = render_palette_css(data)

    if args.check:
        ok = True
        for path, expected in [(CATALOG_JS, expected_catalog), (KINDS_JS, expected_kinds), (PALETTE_CSS, expected_palette)]:
            actual = path.read_text(encoding="utf-8") if path.exists() else ""
            if actual != expected:
                print(f"DRIFT {path.relative_to(ROOT)}")
                ok = False
        if not ok:
            print("Run python tools/sync_catalog.py to regenerate")
            sys.exit(1)
        print("frontend catalog in sync with skus.json")
        return

    CATALOG_JS.write_text(expected_catalog, encoding="utf-8")
    KINDS_JS.write_text(expected_kinds, encoding="utf-8")
    PALETTE_CSS.write_text(expected_palette, encoding="utf-8")
    print(f"wrote {CATALOG_JS.relative_to(ROOT)}, {KINDS_JS.relative_to(ROOT)}, {PALETTE_CSS.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
