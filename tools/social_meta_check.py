#!/usr/bin/env python3
"""Check the audit page's social-preview metadata (issue #7).

A share link renders from `<meta property="og:...">`. Two failure modes are
invisible in a browser and only show up in someone else's Slack or Teams card:

  * a **relative** `og:image` — crawlers resolve it against whatever base they
    choose, and several refuse to resolve it at all, so the card renders bare;
  * a **missing** `og:url` — the crawler falls back to the URL it fetched,
    which is not necessarily the canonical one after redirects.

Both are also easy to reintroduce from a template. The check is static: it
reads the committed `index.html` and asserts the deployed-origin properties.
Live confirmation is a separate, deliberate fetch (see the issue), because the
served page is only evidence after a deploy.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CANONICAL = "https://audit.wantnot.ebbwater.net/"

_META = re.compile(r"<meta\s+([^>]*?)/?>", re.IGNORECASE | re.DOTALL)
_ATTR = re.compile(r'([a-zA-Z:-]+)\s*=\s*"([^"]*)"')


def _meta_tags(html: str) -> list[dict[str, str]]:
    tags = []
    for body in _META.findall(html):
        attrs = {k.lower(): v for k, v in _ATTR.findall(body)}
        if attrs:
            tags.append(attrs)
    return tags


def _by_property(tags: list[dict[str, str]], prop: str) -> str | None:
    for tag in tags:
        if tag.get("property", "").lower() == prop.lower():
            return tag.get("content")
    return None


def _by_name(tags: list[dict[str, str]], name: str) -> str | None:
    for tag in tags:
        if tag.get("name", "").lower() == name.lower():
            return tag.get("content")
    return None


def check(root: Path = ROOT) -> list[str]:
    """Return the list of failures; empty means the metadata is correct."""
    index = root / "index.html"
    if not index.is_file():
        return ["index.html is missing"]
    html = index.read_text(encoding="utf-8")
    tags = _meta_tags(html)
    failures: list[str] = []

    image = _by_property(tags, "og:image")
    if not image:
        failures.append("og:image is missing")
    elif not image.startswith("https://"):
        failures.append(f"og:image must be an absolute https URL, found {image!r}")

    url = _by_property(tags, "og:url")
    if not url:
        failures.append("og:url is missing")
    elif url != CANONICAL:
        failures.append(f"og:url must be the canonical origin {CANONICAL}, found {url!r}")

    # The declared canonical link and og:url must not disagree: two different
    # canonical claims on one page is the ambiguity this check exists to stop.
    canonical_links = re.findall(
        r'<link\s+[^>]*rel="canonical"[^>]*href="([^"]+)"', html, re.IGNORECASE
    )
    if canonical_links and canonical_links[0] != CANONICAL:
        failures.append(
            f'<link rel="canonical"> must be {CANONICAL}, found {canonical_links[0]!r}'
        )
    if url and canonical_links and url != canonical_links[0]:
        failures.append(
            f"og:url ({url!r}) disagrees with <link rel=canonical> ({canonical_links[0]!r})"
        )

    for prop in ("og:title", "og:description", "og:type"):
        if not _by_property(tags, prop):
            failures.append(f"{prop} is missing")
    if _by_name(tags, "twitter:card") is None:
        failures.append("twitter:card is missing")

    # An absolute URL that points at a file the repository does not ship is a
    # broken card with extra steps. Only checked for an image on the canonical
    # origin, which is the case this page uses.
    if image and image.startswith(CANONICAL):
        rel = image[len(CANONICAL):]
        if not (root / rel).is_file():
            failures.append(f"og:image points at {rel!r}, which is not in the repository")

    return failures


def main() -> int:
    failures = check()
    if failures:
        for failure in failures:
            print(f"FAIL {failure}")
        return 1
    print("OK social metadata is absolute and agrees with the canonical origin")
    return 0


if __name__ == "__main__":
    sys.exit(main())
