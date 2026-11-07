"""Markdown -> PDF for the course workbench (CJK-safe, no Office needed).

Usage:  python md2pdf.py <input.md> <output.pdf> [--title "封面标题"]

The skills write Markdown first because it is what the right-hand preview shows;
this turns the same file into a PDF next to it. Fonts come from Windows (SimHei),
so no LibreOffice, Word, or network is involved.
"""

from __future__ import annotations

import html
import logging
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# fpdf2 is installed beside this script, not into the interpreter's site-packages.
sys.path.insert(0, os.path.join(HERE, "pypdf"))

# fontTools warns that it cannot subset one of the tables in SimHei; the file is
# still written correctly, and the notice only makes callers think it failed.
logging.getLogger("fontTools.subset").setLevel(logging.ERROR)

from fpdf import FPDF  # noqa: E402

FONT_REGULAR = r"C:\Windows\Fonts\simhei.ttf"
FONT_BOLD = r"C:\Windows\Fonts\simhei.ttf"
FONT_MONO = r"C:\Windows\Fonts\consola.ttf"
# SimHei lacks a few punctuation glyphs (the list bullet among them); Deng
# covers them and is only consulted for what the main face cannot draw.
FONT_FALLBACK = r"C:\Windows\Fonts\Deng.ttf"

BODY_SIZE = 10.5
CODE_SIZE = 9


def _esc(text: str) -> str:
    return html.escape(text, quote=False)


def _inline(text: str) -> str:
    """Inline markdown -> the small HTML subset fpdf2 renders."""
    text = _esc(text)
    text = re.sub(r"`([^`]+)`", r"<font name='mono'>\1</font>", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<i>\1</i>", text)
    return text


def _table(rows: list[list[str]]) -> str:
    out = ['<table border="1" cellpadding="3" width="100%">']
    header, body = rows[0], rows[1:]
    out.append("<thead><tr>")
    for cell in header:
        out.append(f"<th>{_inline(cell)}</th>")
    out.append("</tr></thead><tbody>")
    for row in body:
        out.append("<tr>")
        for cell in row:
            out.append(f"<td>{_inline(cell)}</td>")
        out.append("</tr>")
    out.append("</tbody></table>")
    return "".join(out)


def markdown_to_html(text: str) -> str:
    """A deliberately small Markdown subset: what the skills actually emit."""
    lines = text.splitlines()
    out: list[str] = []
    index = 0
    list_stack: list[str] = []

    def close_lists() -> None:
        while list_stack:
            out.append(f"</{list_stack.pop()}>")

    while index < len(lines):
        line = lines[index]
        stripped = line.strip()

        if stripped == "":
            close_lists()
            index += 1
            continue

        # Fenced code block.
        if stripped.startswith("```"):
            close_lists()
            index += 1
            block: list[str] = []
            while index < len(lines) and not lines[index].strip().startswith("```"):
                block.append(lines[index])
                index += 1
            index += 1
            out.append(
                "<pre><font name='mono' size='%s'>%s</font></pre>"
                % (CODE_SIZE, _esc("\n".join(block)))
            )
            continue

        # Table: a header row followed by a |---| separator row.
        if (
            stripped.startswith("|")
            and index + 1 < len(lines)
            and re.match(r"^\s*\|?[\s:\-|]+\|[\s:\-|]*$", lines[index + 1])
        ):
            close_lists()
            rows: list[list[str]] = []
            rows.append([c.strip() for c in stripped.strip("|").split("|")])
            index += 2
            while index < len(lines) and lines[index].strip().startswith("|"):
                rows.append([c.strip() for c in lines[index].strip().strip("|").split("|")])
                index += 1
            out.append(_table(rows))
            continue

        heading = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if heading:
            close_lists()
            level = len(heading.group(1))
            out.append(f"<h{level}>{_inline(heading.group(2))}</h{level}>")
            index += 1
            continue

        if re.match(r"^(-{3,}|\*{3,}|_{3,})$", stripped):
            close_lists()
            out.append("<hr/>")
            index += 1
            continue

        if stripped.startswith(">"):
            close_lists()
            quote: list[str] = []
            while index < len(lines) and lines[index].strip().startswith(">"):
                quote.append(lines[index].strip().lstrip(">").strip())
                index += 1
            out.append(f"<blockquote><p>{_inline(' '.join(quote))}</p></blockquote>")
            continue

        bullet = re.match(r"^([-*+])\s+(.*)$", stripped)
        numbered = re.match(r"^(\d+)[.)]\s+(.*)$", stripped)
        if bullet or numbered:
            tag = "ul" if bullet else "ol"
            if not list_stack or list_stack[-1] != tag:
                close_lists()
                list_stack.append(tag)
                out.append(f"<{tag}>")
            item = (bullet or numbered).group(2)
            out.append(f"<li>{_inline(item)}</li>")
            index += 1
            continue

        close_lists()
        paragraph: list[str] = [stripped]
        index += 1
        while index < len(lines):
            nxt = lines[index].strip()
            if (
                nxt == ""
                or nxt.startswith("#")
                or nxt.startswith("|")
                or nxt.startswith("```")
                or nxt.startswith(">")
                or re.match(r"^([-*+]|\d+[.)])\s+", nxt)
            ):
                break
            paragraph.append(nxt)
            index += 1
        out.append(f"<p>{_inline(' '.join(paragraph))}</p>")

    close_lists()
    return "".join(out)


def convert(source: str, target: str, title: str | None = None) -> None:
    # utf-8-sig: a BOM would otherwise glue itself to the first heading line.
    with open(source, encoding="utf-8-sig") as handle:
        text = handle.read()

    body = markdown_to_html(text)

    pdf = FPDF(format="A4")
    pdf.set_margins(16, 16, 16)
    pdf.set_auto_page_break(True, margin=16)
    pdf.add_font("hei", "", FONT_REGULAR)
    pdf.add_font("hei", "B", FONT_BOLD)
    pdf.add_font("mono", "", FONT_MONO)
    pdf.add_font("fallback", "", FONT_FALLBACK)
    pdf.set_fallback_fonts(["fallback"])
    pdf.set_font("hei", "", BODY_SIZE)
    pdf.add_page()

    # fpdf2 renders unknown families through the current font, so the HTML
    # subset above only needs `hei` and `mono` registered.
    pdf.write_html(f"<body>{body}</body>")

    if title:
        pdf.set_title(title)
    pdf.output(target)


def main() -> int:
    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    title = None
    for index, arg in enumerate(sys.argv[1:]):
        if arg == "--title" and index + 2 <= len(sys.argv) - 1:
            title = sys.argv[index + 2]
    if len(argv) < 2:
        print("usage: python md2pdf.py <input.md> <output.pdf> [--title T]", file=sys.stderr)
        return 2
    source, target = argv[0], argv[1]
    if not os.path.isfile(source):
        print(f"md2pdf: input not found: {source}", file=sys.stderr)
        return 2
    os.makedirs(os.path.dirname(os.path.abspath(target)) or ".", exist_ok=True)
    convert(source, target, title)
    if not os.path.isfile(target) or os.path.getsize(target) < 1000:
        print("md2pdf: output looks empty", file=sys.stderr)
        return 1
    print(f"md2pdf: {target} ({os.path.getsize(target)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
