#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Loop46, Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Check a static site before it publishes. Exit 1 on any finding.

    python3 marketing/_tests/check_links.py [SITE_DIR]   (default: marketing)

Invariants, each one a thing that has shipped broken before:

1. Every internal link resolves. A path resolves the way the worker's static
   lookup resolves it: `/` is `_static/index.html`; otherwise `_static/<p>`,
   then `_static/<p>.html`, then `_static/<p>/index.html`. A trailing slash
   is stripped first (the worker 301s it).
2. No page loads anything from another host — no external `src`, `<link>`,
   CSS `@import` or `url(...)`. Pages state who receives visitors' data; a
   third-party load would contradict them. Plain `<a>` links to other sites
   are fine and are not fetched.
3. No draft markers (`class="decide"` / `class="draft"`) — policy text
   awaiting sign-off must not ship.
4. Every file name is one the deploy path accepts: `[a-z0-9-_./]` only.

Lives under `_tests/` so the deploy walk never ships it. Runs as the
marketing tenant's `generate` hook (web/manifest.json), so a failing check
aborts the publish, and in CI on every PR touching marketing/.
"""
import html.parser
import pathlib
import re
import sys

EXTERNAL = re.compile(r"^(?:[a-z][a-z0-9+.-]*:)?//", re.I)
CSS_URL = re.compile(r"""@import\s+(?:url\()?\s*['"]?([^'")\s;]+)|url\(\s*['"]?([^'")]+)""", re.I)
NAME_OK = re.compile(r"^[a-z0-9\-_./]+$")


class Page(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.links, self.loads, self.styles = [], [], []
        self._in_style = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "a" and a.get("href"):
            self.links.append(a["href"])
        if a.get("src"):
            self.loads.append(a["src"])
        if tag == "link" and a.get("href"):
            self.loads.append(a["href"])
        if a.get("style"):
            self.styles.append(a["style"])
        self._in_style = tag == "style"

    def handle_endtag(self, tag):
        if tag == "style":
            self._in_style = False

    def handle_data(self, data):
        if self._in_style:
            self.styles.append(data)


def resolves(static: pathlib.Path, base: pathlib.Path, ref: str) -> bool:
    path = ref.split("#", 1)[0].split("?", 1)[0]
    if path == "":
        return True  # same-page fragment
    if path.startswith("/"):
        rel = path.lstrip("/").rstrip("/")
        if rel == "":
            return (static / "index.html").is_file()
        target = static / rel
    else:
        target = (base / path).resolve()
    return (target.is_file()
            or target.with_name(target.name + ".html").is_file()
            or (target / "index.html").is_file())


def css_refs(text: str):
    for m in CSS_URL.finditer(text):
        ref = m.group(1) or m.group(2)
        if ref and not ref.startswith("data:"):
            yield ref


def check(site: pathlib.Path) -> list[str]:
    static = site / "_static"
    problems = []
    for f in sorted(static.rglob("*")):
        if not f.is_file():
            continue
        rel = f.relative_to(site).as_posix()
        if not NAME_OK.match(rel):
            problems.append(f"{rel}: name has characters the deploy path rejects")
        if f.suffix == ".css":
            text = f.read_text()
            for ref in css_refs(text):
                if EXTERNAL.match(ref):
                    problems.append(f"{rel}: loads from another host: {ref}")
                elif not resolves(static, f.parent, ref):
                    problems.append(f"{rel}: url() does not resolve: {ref}")
        if f.suffix != ".html":
            continue
        text = f.read_text()
        page = Page()
        page.feed(text)
        for marker in ('class="decide"', 'class="draft"'):
            if marker in text:
                problems.append(f"{rel}: draft marker {marker} present")
        for ref in page.loads:
            if ref.startswith("data:"):
                continue
            if EXTERNAL.match(ref):
                problems.append(f"{rel}: loads from another host: {ref}")
            elif not resolves(static, f.parent, ref):
                problems.append(f"{rel}: resource does not resolve: {ref}")
        for style in page.styles:
            for ref in css_refs(style):
                if EXTERNAL.match(ref):
                    problems.append(f"{rel}: loads from another host: {ref}")
        for ref in page.links:
            if EXTERNAL.match(ref) or ref.startswith(("mailto:", "tel:", "data:")):
                continue
            if not resolves(static, f.parent, ref):
                problems.append(f"{rel}: link does not resolve: {ref}")
    return problems


def main() -> int:
    site = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "marketing")
    if not (site / "_static").is_dir():
        print(f"check_links: {site}/_static not found", file=sys.stderr)
        return 2
    problems = check(site)
    for p in problems:
        print(f"check_links: {p}", file=sys.stderr)
    pages = len(list((site / "_static").rglob("*.html")))
    print(f"check_links: {site}: {pages} pages, {len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
