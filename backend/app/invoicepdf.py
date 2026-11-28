"""Invoices and credit notes as A4 PDFs (0.65.0, the user's request: "more professional … always A4 … big orders may
be multiple pages … print or download as PDF").

Drawn with reportlab from the invoice's own snapshots (seller, buyer, car, lines, VAT), so a PDF made today looks the
same as one made the day it was issued. Always Norwegian, like the other documents.

Layout (first page): logo top left (or the company name), the seller's details top right, the buyer where a window
envelope shows it, FAKTURA / KREDITNOTA with a box of invoice details, a box with the car and the order, then the
lines. Later pages: a short header. Every page: a footer with the company's details and "Side n av m". The lines table
repeats its header on each page; the totals and payment details are kept together at the end.
"""
from __future__ import annotations

import io
from decimal import Decimal
from pathlib import Path
from typing import Optional
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import (BaseDocTemplate, Frame, KeepTogether, NextPageTemplate, PageTemplate, Paragraph,
                                Spacer, Table, TableStyle)

W, H = A4
LEFT = RIGHT = 18 * mm
RIGHT_COL = 116 * mm                 # x where the right-hand header column starts
FIRST_TOP = 122 * mm                 # where the lines start on page 1 (from the top)
LATER_TOP = 30 * mm
BOTTOM = 30 * mm                     # room for the footer
INK = colors.HexColor("#1C1B19")
GREY = colors.HexColor("#6B6B6B")
RULE = colors.HexColor("#D9D9D9")
SHADE = colors.HexColor("#F1F1F1")

BODY = ParagraphStyle("body", fontName="Helvetica", fontSize=9, leading=11.5, textColor=INK)
SMALL = ParagraphStyle("small", parent=BODY, fontSize=8, leading=10, textColor=GREY)


def nok(x) -> str:
    """1 040,00 (Norwegian; a no-break space between thousands; a plain hyphen for minus, which every font has)."""
    s = f"{Decimal(str(x or 0)):,.2f}"
    return s.replace(",", " ").replace(".", ",")


def qty(x) -> str:
    """4,30 → "4,3"; 2 → "2"; 12000 → "12 000"."""
    d = Decimal(str(x or 0))
    s = f"{d:,.0f}" if d == d.to_integral() else f"{d:,.2f}".rstrip("0").rstrip(".")
    return s.replace(",", " ").replace(".", ",")


def pct(x) -> str:
    d = Decimal(str(x or 0)).normalize()
    return f"{d:f}".replace(".", ",") + " %"


def no_date(iso) -> str:
    s = str(iso or "")[:10]
    return ".".join(reversed(s.split("-"))) if len(s) == 10 else ""


def org_line(s: dict) -> Optional[str]:
    if not s.get("org_no"):
        return None
    return f"Org.nr. NO {s['org_no']} MVA" if s.get("vat_registered") else f"Org.nr. {s['org_no']}"


def _p(text, style=BODY) -> Paragraph:
    return Paragraph(escape(str(text or "")).replace("\n", "<br/>"), style)


class _NumberedCanvas(rl_canvas.Canvas):
    """Draws "Side n av m" once the number of pages is known."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._pages = []

    def showPage(self):
        self._pages.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._pages)
        for state in self._pages:
            self.__dict__.update(state)
            self.setFont("Helvetica", 7.5)
            self.setFillColor(GREY)
            self.drawRightString(W - RIGHT, 10 * mm, f"Side {self._pageNumber} av {total}")
            super().showPage()
        super().save()


def build(inv: dict, logo: Optional[Path] = None) -> bytes:
    s, b, c = inv.get("seller") or {}, inv.get("buyer") or {}, inv.get("car") or {}
    is_invoice = inv.get("kind") == "invoice"
    title = "FAKTURA" if is_invoice else "KREDITNOTA"
    logo_img = None
    if logo and logo.exists():
        try:
            logo_img = ImageReader(str(logo))
        except Exception:
            logo_img = None

    def line(cv, y_from_top, x1=LEFT, x2=W - RIGHT, color=RULE, width=0.6):
        cv.setStrokeColor(color)
        cv.setLineWidth(width)
        cv.line(x1, H - y_from_top, x2, H - y_from_top)

    def label_value(cv, x, y_top, label, value, *, bold=False, mono=False, size=9.5, max_chars=24):
        cv.setFont("Helvetica-Bold", 6.8)
        cv.setFillColor(GREY)
        cv.drawString(x, H - y_top, label.upper())
        cv.setFont("Courier-Bold" if mono and bold else "Courier" if mono else "Helvetica-Bold" if bold else "Helvetica", size)
        cv.setFillColor(INK)
        cv.drawString(x, H - y_top - 4.3 * mm, str(value if value not in (None, "") else "–")[:max_chars])

    def footer(cv):
        line(cv, H - 22 * mm, color=RULE)
        cv.setFont("Helvetica", 7.5)
        cv.setFillColor(GREY)
        first = " · ".join(x for x in (s.get("name"), (s.get("address") or "").replace("\n", ", "),
                                       f"Tlf. {s['phone']}" if s.get("phone") else None, s.get("email")) if x)
        second = " · ".join(x for x in (org_line(s), "Foretaksregisteret" if s.get("foretaksregisteret") else None,
                                        f"Kontonr. {s['bank_account']}" if s.get("bank_account") else None) if x)
        cv.drawCentredString(W / 2, 17 * mm, first[:150])
        cv.drawCentredString(W / 2, 13.5 * mm, second[:150])

    def first_page(cv, _doc):
        cv.saveState()
        # Logo (or the company name), top left.
        if logo_img:
            iw, ih = logo_img.getSize()
            scale = min(78 * mm / iw, 26 * mm / ih)
            w, h = iw * scale, ih * scale
            cv.drawImage(logo_img, LEFT, H - 14 * mm - h, w, h, mask="auto", preserveAspectRatio=True)
        else:
            cv.setFont("Helvetica-Bold", 18)
            cv.setFillColor(INK)
            cv.drawString(LEFT, H - 24 * mm, (s.get("name") or "")[:40])
        # The seller, top right.
        y = 16 * mm
        cv.setFont("Helvetica-Bold", 11.5)
        cv.setFillColor(INK)
        cv.drawString(RIGHT_COL, H - y, (s.get("name") or "")[:45])
        cv.setFont("Helvetica", 8.5)
        rows = [x for x in (s.get("address") or "").split("\n") if x.strip()][:3]
        rows += [f"Telefon: {s['phone']}" if s.get("phone") else None, f"E-post: {s['email']}" if s.get("email") else None,
                 org_line(s), "Foretaksregisteret" if s.get("foretaksregisteret") else None]
        for r in [x for x in rows if x]:
            y += 4.1 * mm
            cv.drawString(RIGHT_COL, H - y, r[:60])
        # The buyer, where a window envelope shows it (C5/E65: about 20 mm from the left, 45–70 mm from the top).
        cv.setFont("Helvetica-Bold", 6.8)
        cv.setFillColor(GREY)
        cv.drawString(LEFT + 2 * mm, H - 50 * mm, "FAKTURERES TIL" if is_invoice else "KUNDE")
        cv.setFillColor(INK)
        cv.setFont("Helvetica-Bold", 11)
        cv.drawString(LEFT + 2 * mm, H - 55.5 * mm, (b.get("name") or "")[:45])
        cv.setFont("Helvetica", 10)
        by = 55.5 * mm
        for r in [x for x in (b.get("address") or "").split("\n") if x.strip()][:2] + \
                [" ".join(x for x in (b.get("postal_code"), b.get("city")) if x)] + \
                ([f"Org.nr. {b['org_no']}"] if b.get("org_no") else []):
            if r.strip():
                by += 4.8 * mm
                cv.drawString(LEFT + 2 * mm, H - by, r[:50])
        # Title and the box of invoice details, right.
        cv.setFont("Helvetica-Bold", 22)
        cv.drawString(RIGHT_COL, H - 56 * mm, title)
        box_top, box_h = 61 * mm, 25 * mm
        cv.setStrokeColor(RULE)
        cv.setLineWidth(0.8)
        cv.roundRect(RIGHT_COL, H - box_top - box_h, W - RIGHT - RIGHT_COL, box_h, 2 * mm, stroke=1, fill=0)
        col = (W - RIGHT - RIGHT_COL - 6 * mm) / 3
        x0 = RIGHT_COL + 3 * mm
        label_value(cv, x0, box_top + 5 * mm, "Fakturanr." if is_invoice else "Kreditnotanr.", inv.get("number"), bold=True)
        label_value(cv, x0 + col, box_top + 5 * mm, "Fakturadato" if is_invoice else "Dato", no_date(inv.get("issue_date")))
        label_value(cv, x0 + 2 * col, box_top + 5 * mm, "Forfall" if is_invoice else "Leveringsdato",
                    no_date(inv.get("due_date") if is_invoice else inv.get("delivery_date")), bold=is_invoice)
        label_value(cv, x0, box_top + 15.5 * mm, "Kundenr.", b.get("customer_no"))
        if is_invoice:
            label_value(cv, x0 + col, box_top + 15.5 * mm, "Leveringsdato", no_date(inv.get("delivery_date")))
            label_value(cv, x0 + 2 * col, box_top + 15.5 * mm, "KID" if inv.get("kid") else "Kontonr.",
                        inv.get("kid") or s.get("bank_account"), size=8.5)
        elif inv.get("credits_number"):
            label_value(cv, x0 + col, box_top + 15.5 * mm, "Krediterer faktura", inv.get("credits_number"))
        # The car and the order, full width.
        top, h = 94 * mm, 21 * mm
        cv.setFillColor(SHADE)
        cv.roundRect(LEFT, H - top - h, W - LEFT - RIGHT, h, 2 * mm, stroke=0, fill=1)
        model = " ".join(x for x in (c.get("make"), c.get("model")) if x)
        cols = [("Reg.nr.", c.get("registration_number"), True, False), ("Bilmodell", model, False, False),
                ("Km-stand", qty(c["km"]) if c.get("km") is not None else None, False, False)]
        x = LEFT + 4 * mm
        for lab, val, bold, mono in cols:
            label_value(cv, x, top + 5 * mm, lab, val, bold=bold, mono=mono, max_chars=30 if lab == "Bilmodell" else 18)
            x += 42 * mm if lab != "Bilmodell" else 56 * mm
        label_value(cv, LEFT + 4 * mm, top + 14.5 * mm, "Understellsnr. (VIN)", c.get("vin"), mono=True, size=9,
                    max_chars=30)
        order_label, order_no = (("Arbeidsordre", c.get("work_order")) if c.get("work_order")
                                 else ("Delebestilling", c.get("parts_order")) if c.get("parts_order") else (None, None))
        rx = LEFT + 4 * mm + 98 * mm
        if order_label:
            label_value(cv, rx + 42 * mm, top + 5 * mm, order_label, order_no, bold=True)
        if c.get("mechanic"):
            label_value(cv, rx, top + 14.5 * mm, "Mekaniker", c.get("mechanic"), size=9)
        if c.get("our_ref"):
            label_value(cv, rx + 42 * mm, top + 14.5 * mm, "Vår ref.", c.get("our_ref"), size=9)
        footer(cv)
        cv.restoreState()

    def later_page(cv, _doc):
        cv.saveState()
        cv.setFont("Helvetica-Bold", 10)
        cv.setFillColor(INK)
        cv.drawString(LEFT, H - 17 * mm, f"{title.capitalize()} nr. {inv.get('number')}")
        cv.setFont("Helvetica", 9)
        cv.drawRightString(W - RIGHT, H - 17 * mm,
                           " · ".join(x for x in (b.get("name"), c.get("registration_number"), no_date(inv.get("issue_date"))) if x))
        line(cv, 21 * mm)
        footer(cv)
        cv.restoreState()

    out = io.BytesIO()
    doc = BaseDocTemplate(out, pagesize=A4, leftMargin=LEFT, rightMargin=RIGHT, topMargin=LATER_TOP,
                          bottomMargin=BOTTOM, title=f"{title.capitalize()} {inv.get('number')}",
                          author=s.get("name") or "", subject=title.capitalize())
    width = W - LEFT - RIGHT
    doc.addPageTemplates([
        PageTemplate("first", [Frame(LEFT, BOTTOM, width, H - FIRST_TOP - BOTTOM, 0, 0, 0, 0)], onPage=first_page),
        PageTemplate("later", [Frame(LEFT, BOTTOM, width, H - LATER_TOP - BOTTOM, 0, 0, 0, 0)], onPage=later_page),
    ])
    story = [NextPageTemplate("later")]
    if not is_invoice and inv.get("credits_number"):
        story += [_p(f"Krediterer faktura nr. {inv['credits_number']} datert {no_date(inv.get('credits_issue_date'))}."),
                  Spacer(0, 3 * mm)]

    # The lines.
    lines = inv.get("lines") or []
    has_discount = any(Decimal(str(ln.get("discount") or 0)) for ln in lines)
    head = ["Varenr.", "Beskrivelse", "Antall", "Enhet", "Pris"] + (["Rab."] if has_discount else []) + ["Mva", "Beløp"]
    widths = [27 * mm, None, 15 * mm, 12 * mm, 22 * mm] + ([12 * mm] if has_discount else []) + [12 * mm, 24 * mm]
    fixed = sum(x for x in widths if x)
    widths = [x if x else width - fixed for x in widths]
    hstyle = ParagraphStyle("h", parent=BODY, fontName="Helvetica-Bold", fontSize=7.5, textColor=GREY)
    hright = ParagraphStyle("hr", parent=hstyle, alignment=2)
    first_num = 2   # Antall and the columns after it are numbers (right-aligned), except Enhet
    data = [[Paragraph(x.upper(), hright if i >= first_num and x != "Enhet" else hstyle) for i, x in enumerate(head)]]
    for ln in lines:
        disc = ln.get("kind") == "discount"
        row = [_p(ln.get("part_number") or "", SMALL), _p(ln.get("text")),
               "" if disc else qty(ln.get("quantity")), ln.get("unit") or "",
               "" if disc else nok(ln.get("unit_price"))]
        if has_discount:
            row.append(pct(ln["discount"]) if Decimal(str(ln.get("discount") or 0)) else "")
        row += [pct(ln.get("vat_rate")), nok(ln.get("total_ex"))]
        data.append(row)
    table = Table(data, colWidths=widths, repeatRows=1)
    table.setStyle(TableStyle([
        ("FONT", (0, 1), (-1, -1), "Helvetica", 9),
        ("TEXTCOLOR", (0, 1), (-1, -1), INK),
        ("BACKGROUND", (0, 0), (-1, 0), SHADE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ALIGN", (first_num, 0), (-1, -1), "RIGHT"),
        ("ALIGN", (3, 0), (3, -1), "LEFT"),
        ("LINEBELOW", (0, 0), (-1, 0), 0.8, INK),
        ("LINEBELOW", (0, 1), (-1, -1), 0.4, RULE),
        ("TOPPADDING", (0, 0), (-1, -1), 3.2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.2),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
    ]))
    story.append(table)
    story.append(Spacer(0, 5 * mm))

    # Totals, payment and notes: kept together at the end.
    tot = [["Sum eks. mva", nok(inv.get("total_ex"))]]
    for v in inv.get("vat_lines") or []:
        tot.append([f"Mva {pct(v.get('rate'))} av {nok(v.get('base'))}", nok(v.get("vat"))])
    tot.append(["Å betale (NOK)" if is_invoice else "Til gode (NOK)", nok(inv.get("total_inc"))])
    totals = Table(tot, colWidths=[52 * mm, 30 * mm], hAlign="RIGHT")
    totals.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, -2), "Helvetica", 9),
        ("FONT", (0, -1), (-1, -1), "Helvetica-Bold", 11.5),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.8, INK),
        ("LINEBELOW", (0, -1), (-1, -1), 1.6, INK),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
        ("TOPPADDING", (0, -1), (-1, -1), 5),
        ("BOTTOMPADDING", (0, -1), (-1, -1), 5),
    ]))
    end = [totals]
    if not s.get("vat_registered"):
        end += [Spacer(0, 3 * mm),
                _p("Selger er ikke registrert i Merverdiavgiftsregisteret. Det er ikke beregnet merverdiavgift.", SMALL)]
    if is_invoice:
        pay = [x for x in (f"Kontonr. <b>{escape(s['bank_account'])}</b>" if s.get("bank_account") else None,
                           f"KID <b>{escape(inv['kid'])}</b>" if inv.get("kid") else None,
                           f"Forfall <b>{no_date(inv.get('due_date'))}</b>",
                           f"Beløp <b>{nok(inv.get('total_inc'))} kr</b>") if x]
        box = Table([[Paragraph("<b>Betaling</b>&nbsp;&nbsp;&nbsp;" + "&nbsp;&nbsp;·&nbsp;&nbsp;".join(pay), BODY)]],
                    colWidths=[width])
        box.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.8, RULE), ("TOPPADDING", (0, 0), (-1, -1), 6),
                                 ("BOTTOMPADDING", (0, 0), (-1, -1), 6), ("LEFTPADDING", (0, 0), (-1, -1), 8)]))
        end += [Spacer(0, 6 * mm), box]
    if inv.get("note"):
        end += [Spacer(0, 4 * mm), _p(inv["note"])]
    if s.get("footer"):
        end += [Spacer(0, 4 * mm), _p(s["footer"], SMALL)]
    story.append(KeepTogether(end))
    doc.build(story, canvasmaker=_NumberedCanvas)
    return out.getvalue()
