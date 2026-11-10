#!/usr/bin/env python3
"""Check the audit origin's crawler files and their Static Web Apps wiring.

The audit app is a single public page. Its navigation fallback rewrites unknown
paths to index.html, so /robots.txt and /sitemap.xml must be excluded or they
return HTML instead of the files. These are small, easy-to-regress surfaces.
"""

from __future__ import annotations

import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CANONICAL = "https://audit.wantnot.ebbwater.net/"
SITEMAP_URL = CANONICAL + "sitemap.xml"
NS = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}


def main() -> int:
    failures: list[str] = []

    config = json.loads((ROOT / "staticwebapp.config.json").read_text(encoding="utf-8"))
    exclude = config.get("navigationFallback", {}).get("exclude", [])
    for path in ("/robots.txt", "/sitemap.xml"):
        if path not in exclude:
            failures.append(f"navigationFallback.exclude is missing {path}")

    robots = (ROOT / "robots.txt").read_text(encoding="utf-8")
    lines = [line.strip() for line in robots.splitlines()]
    if "User-agent: *" not in lines:
        failures.append("robots.txt has no 'User-agent: *' group")
    if "Allow: /" not in lines:
        failures.append("robots.txt does not allow the public page")
    if f"Sitemap: {SITEMAP_URL}" not in lines:
        failures.append(f"robots.txt does not name {SITEMAP_URL}")
    if any(line.lower().startswith("disallow:") for line in lines):
        failures.append("robots.txt contains a Disallow rule the Allow decision did not intend")

    try:
        tree = ET.parse(ROOT / "sitemap.xml")
    except ET.ParseError as exc:
        failures.append(f"sitemap.xml is not valid XML: {exc}")
    else:
        locs = [el.text for el in tree.getroot().findall("sm:url/sm:loc", NS)]
        if locs != [CANONICAL]:
            failures.append(f"sitemap.xml must list exactly {CANONICAL}, found {locs}")

    if failures:
        for failure in failures:
            print(f"FAIL {failure}")
        return 1

    print(f"OK robots allows the audit page and sitemap lists {CANONICAL}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
