"""The hosted pages introduce themselves well: link previews, a real 404 and no-script notes."""
import re
import struct
import unittest
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = "https://ghostwheel-one.vercel.app"
PAGES = ("index.html", "public/ghostwheel-decision-lab.html", "public/ghostwheel-fourier-epicycles.html")


class Head(HTMLParser):
    def __init__(self):
        super().__init__()
        self.meta, self.links, self.scripts, self.noscript = {}, [], [], False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta" and ("property" in attrs or "name" in attrs):
            self.meta[attrs.get("property") or attrs.get("name")] = attrs.get("content", "")
        elif tag == "a":
            self.links.append(attrs.get("href", ""))
        elif tag == "script":
            self.scripts.append(attrs)
        elif tag == "noscript":
            self.noscript = True


def parse(relative):
    page = Head()
    page.feed((ROOT / relative).read_text(encoding="utf-8"))
    return page


class WebPublicationTests(unittest.TestCase):
    def test_every_page_shares_a_large_preview_that_exists(self):
        for relative in PAGES:
            with self.subTest(page=relative):
                meta = parse(relative).meta
                for key in ("og:title", "og:description", "og:url", "og:image", "og:image:alt"):
                    self.assertTrue(meta.get(key), f"{relative} is missing {key}")
                self.assertEqual(meta.get("twitter:card"), "summary_large_image")
                self.assertTrue(meta["og:url"].startswith(SITE + "/"))
                image = meta["og:image"]
                self.assertEqual(meta.get("twitter:image"), image)
                self.assertTrue(image.startswith(SITE + "/"), "previews need an absolute URL")
                card = ROOT / "public" / image.removeprefix(SITE + "/")
                data = card.read_bytes()
                self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
                width, height = struct.unpack(">II", data[16:24])
                self.assertEqual((width, height), (1200, 630))
                self.assertEqual((meta.get("og:image:width"), meta.get("og:image:height")), ("1200", "630"))

    def test_unknown_addresses_get_a_designed_page_within_the_site_policy(self):
        page = parse("public/404.html")
        # The site CSP allows scripts only from files; the page needs none.
        self.assertEqual(page.scripts, [])
        self.assertIn("/", page.links)
        self.assertEqual(page.meta.get("robots"), "noindex")
        text = (ROOT / "public/404.html").read_text(encoding="utf-8")
        self.assertRegex(text, r"404")
        self.assertRegex(text, r"(?i)simulation only")

    def test_interactive_pages_explain_themselves_without_javascript(self):
        for relative in PAGES:
            with self.subTest(page=relative):
                self.assertTrue(parse(relative).noscript, f"{relative} has no <noscript> note")

    def test_pages_load_scripts_only_from_files(self):
        for relative in (*PAGES, "public/404.html"):
            with self.subTest(page=relative):
                text = (ROOT / relative).read_text(encoding="utf-8")
                inline = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>", text)
                self.assertEqual(inline, [], "the site CSP blocks inline scripts")


if __name__ == "__main__":
    unittest.main()
