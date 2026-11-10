import PDFDocument from 'pdfkit';
import { READING_OBSERVATIONS, USAGES } from '@agua-mata/shared';

/**
 * Recibo del servicio de acueducto en PDF (pdfkit, sin navegador). Mismo contenido que el recibo en pantalla:
 * encabezado con la marca del acueducto, datos del suscriptor, lectura, historial, conceptos y total a pagar.
 * Usa las fuentes estándar de PDF (Helvetica), que incluyen tildes, ñ y «m³».
 */

export interface PdfIssuer {
  name: string;
  legalName: string;
  nit: string;
  municipality: string;
  department: string;
  contactPhone: string;
  contactEmail: string;
  primaryColor?: string;
  receiptFooter?: string;
  /** PNG o JPG. WEBP no lo soporta pdfkit: en ese caso el recibo sale sin logo. */
  logo?: Buffer | null;
}

export interface PdfInvoice {
  number: number;
  period: string;
  status: string;
  issueDate: Date | string;
  dueDate: Date | string;
  consumptionM3: unknown;
  total: unknown;
  previousBalance: unknown;
  subscriberSnapshot: any;
  readingSnapshot: any;
  lines: { concept: string; description: string; quantity: unknown; unitPrice: unknown; amount: unknown }[];
  /** Si existe (facturación electrónica), se imprime con el código de validación. */
  electronic?: { cufe?: string | null; status?: string | null; number?: string | null } | null;
}

const OBS = Object.fromEntries(READING_OBSERVATIONS) as Record<string, string>;
const USAGE = Object.fromEntries(USAGES) as Record<string, string>;
const money = (n: unknown) => Number(n ?? 0).toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const num = (n: unknown, d = 0) => Number(n ?? 0).toLocaleString('es-CO', { maximumFractionDigits: d });
const date = (d: Date | string) => new Date(d).toLocaleDateString('es-CO', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });

/** Las fuentes estándar de PDF usan WinAnsi: se reemplazan los caracteres que no traen (p. ej. el signo menos). */
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.split(''));
const SUBST: Record<string, string> = { '−': '-', '‐': '-', '‑': '-', '×': 'x', '≤': '<=', '≥': '>=', '→': '->' };
export function pdfText(v: unknown): string {
  return Array.from(String(v ?? ''))
    .map((c) => SUBST[c] ?? (c.charCodeAt(0) <= 0xff || WIN_ANSI_EXTRA.has(c) ? c : '?'))
    .join('');
}

const INK = '#15202b';
const MUTED = '#5d6b78';
const LINE = '#d5dde3';

function brand(color?: string) {
  return /^#[0-9a-f]{6}$/i.test(color ?? '') ? color! : '#0b6e99';
}

function isPngOrJpg(b?: Buffer | null) {
  if (!b || b.length < 4) return false;
  const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const jpg = b[0] === 0xff && b[1] === 0xd8;
  return png || jpg;
}

/** Genera un PDF con un recibo por página. `onPage` informa el avance (para tareas en segundo plano). */
export function renderReceiptsPdf(issuer: PdfIssuer, invoices: PdfInvoice[], onPage?: (done: number) => void): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', margin: 40, autoFirstPage: false, info: { Title: `Recibos ${issuer.name}`, Author: issuer.name, Creator: 'AguaMata' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const color = brand(issuer.primaryColor);
  const logo = isPngOrJpg(issuer.logo) ? issuer.logo! : null;

  if (invoices.length === 0) {
    doc.addPage();
    doc.font('Helvetica').fontSize(12).fillColor(INK).text('No hay recibos vigentes para este período.');
  }
  invoices.forEach((inv, i) => {
    doc.addPage();
    drawReceipt(doc, issuer, inv, color, logo);
    onPage?.(i + 1);
  });
  doc.end();
  return done;
}

/** Título pequeño en mayúsculas. Devuelve la posición vertical donde termina. */
function label(doc: PDFKit.PDFDocument, text: string, x: number, y: number, w?: number) {
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(text.toUpperCase(), x, y, { width: w, characterSpacing: 0.3 });
  return doc.y + 1;
}

function drawReceipt(doc: PDFKit.PDFDocument, issuer: PdfIssuer, inv: PdfInvoice, color: string, logo: Buffer | null) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const s = inv.subscriberSnapshot ?? {};
  const r = inv.readingSnapshot ?? {};

  // ── Encabezado ──
  doc.rect(left, 40, width, 4).fill(color);
  let x = left;
  if (logo) {
    try {
      doc.image(logo, left, 56, { fit: [64, 48] });
      x = left + 76;
    } catch {
      x = left;
    }
  }
  doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text(pdfText(issuer.name), x, 56, { width: 300 });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
    .text(pdfText(`${issuer.legalName} · NIT ${issuer.nit}`), x, doc.y + 2, { width: 300 })
    .text(pdfText(`${issuer.municipality}, ${issuer.department} · Tel. ${issuer.contactPhone}`), { width: 300 })
    .text(pdfText(issuer.contactEmail), { width: 300 });

  const boxW = 190;
  doc.roundedRect(right - boxW, 56, boxW, 70, 4).lineWidth(1).strokeColor(color).stroke();
  const ly = label(doc, 'Factura de servicio de acueducto', right - boxW + 10, 64, boxW - 20);
  doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text(`N.º ${inv.number}`, right - boxW + 10, ly + 1, { width: boxW - 20 });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`Período ${inv.period}`, right - boxW + 10, doc.y + 1, { width: boxW - 20 });

  // ── Datos del suscriptor ──
  let y = 140;
  const col = width / 4;
  const cells: [string, string, string?][] = [
    ['Suscriptor', String(s.fullName ?? ''), `Doc. ${s.documentNumber ?? ''}`],
    ['Código / dirección', String(s.code ?? ''), String(s.address ?? '')],
    ['Uso / estrato', `${USAGE[s.usage] ?? s.usage ?? ''}${s.stratum ? ` · Estrato ${s.stratum}` : ''}`],
    ['Expedición / pago oportuno', date(inv.issueDate), `Pagar antes del ${date(inv.dueDate)}`],
  ];
  doc.moveTo(left, y - 6).lineTo(right, y - 6).lineWidth(0.5).strokeColor(LINE).stroke();
  let rowBottom = y;
  cells.forEach(([l, v, extra], i) => {
    const cx = left + i * col;
    const vy = label(doc, l, cx, y, col - 8);
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(pdfText(v), cx, vy, { width: col - 8 });
    if (extra) doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(pdfText(extra), cx, doc.y + 1, { width: col - 8 });
    rowBottom = Math.max(rowBottom, doc.y);
  });

  // ── Lectura y consumo ──
  y = rowBottom + 14;
  doc.moveTo(left, y - 6).lineTo(right, y - 6).lineWidth(0.5).strokeColor(LINE).stroke();
  label(doc, 'Medidor', left, y, col - 8);
  doc.font('Helvetica').fontSize(9).fillColor(INK).text(pdfText(r.meterSerial ?? 'Sin medidor'), left, y + 11, { width: col - 8 });
  if (r.flag === 'ok') {
    doc.fillColor(MUTED).text(`Anterior ${num(r.previousValue, 2)} · Actual ${r.currentValue === null || r.currentValue === undefined ? '—' : num(r.currentValue, 2)}`, { width: col - 8 });
  }
  if (r.observation) doc.fillColor(MUTED).text(pdfText(`${OBS[r.observation] ?? r.observation}${r.isEstimated ? ' (consumo estimado)' : ''}`), { width: col - 8 });
  if (r.flag === 'sin_lectura') doc.fillColor(MUTED).text('Sin lectura en el período: se factura solo el cargo fijo', { width: col - 8 });
  let readBottom = doc.y;

  label(doc, 'Consumo del período', left + col, y, col - 8);
  doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text(`${num(inv.consumptionM3, 2)} m³`, left + col, y + 11, { width: col - 8 });
  readBottom = Math.max(readBottom, doc.y);

  // Historial (barras)
  const history: { period: string; m3: number }[] = [...(r.history ?? [])].reverse();
  const bars = [...history, { period: inv.period, m3: Number(inv.consumptionM3 ?? 0), current: true }].slice(-7);
  const max = Math.max(1, ...bars.map((b) => Number(b.m3)));
  const hx = left + col * 2;
  const hw = col * 2;
  label(doc, 'Historial de consumo (m³)', hx, y, hw);
  const barW = Math.min(30, (hw - 8) / bars.length - 6);
  const baseY = y + 70;
  bars.forEach((b, i) => {
    const bx = hx + i * (barW + 6);
    const h = Math.max(2, (Number(b.m3) / max) * 40);
    doc.rect(bx, baseY - h, barW, h).fill('current' in b ? color : '#b8c4cd');
    doc.font('Helvetica').fontSize(7).fillColor(MUTED)
      .text(num(b.m3), bx - 4, baseY - h - 10, { width: barW + 8, align: 'center' })
      .text(b.period.slice(5), bx - 4, baseY + 3, { width: barW + 8, align: 'center' });
  });
  readBottom = Math.max(readBottom, baseY + 14);

  // ── Conceptos ──
  y = readBottom + 14;
  const cols = [left, left + width * 0.5, left + width * 0.66, left + width * 0.83];
  const colW = [width * 0.5 - 8, width * 0.16 - 8, width * 0.17 - 8, width * 0.17];
  doc.rect(left, y, width, 18).fill('#eef2f5');
  ['Concepto', 'Cantidad', 'Valor unitario', 'Valor'].forEach((h, i) => {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(h.toUpperCase(), cols[i] + 4, y + 5, { width: colW[i] - 4, align: i === 0 ? 'left' : 'right' });
  });
  y += 22;
  for (const l of inv.lines) {
    const isConsumption = l.concept.startsWith('consumo');
    doc.font('Helvetica').fontSize(9).fillColor(INK).text(pdfText(l.description), cols[0] + 4, y, { width: colW[0] - 4 });
    const rowEnd = doc.y;
    doc.text(isConsumption ? `${num(l.quantity, 2)} m³` : '', cols[1] + 4, y, { width: colW[1] - 4, align: 'right' });
    doc.text(isConsumption || l.concept === 'cargo_fijo' ? money(l.unitPrice) : '', cols[2] + 4, y, { width: colW[2] - 4, align: 'right' });
    doc.text(money(l.amount), cols[3] + 4, y, { width: colW[3] - 4, align: 'right' });
    y = Math.max(rowEnd, doc.y) + 4;
    doc.moveTo(left, y - 2).lineTo(right, y - 2).lineWidth(0.3).strokeColor(LINE).stroke();
  }

  const previous = Number(inv.previousBalance ?? 0);
  if (previous > 0) {
    y += 6;
    doc.font('Helvetica').fontSize(9).fillColor(INK).text('Valor de este período', left + 4, y, { width: width * 0.7 });
    doc.text(money(inv.total), cols[3] + 4, y, { width: colW[3] - 4, align: 'right' });
    y = doc.y + 4;
    doc.font('Helvetica-Bold').text('Saldo anterior pendiente (facturas vencidas o por pagar)', left + 4, y, { width: width * 0.7 });
    doc.text(money(previous), cols[3] + 4, y, { width: colW[3] - 4, align: 'right' });
    y = doc.y + 4;
  }

  // ── Total ──
  y += 10;
  doc.rect(left, y, width, 34).fill(color);
  doc.font('Helvetica').fontSize(10).fillColor('#ffffff').text(`Total a pagar · antes del ${date(inv.dueDate)}`, left + 12, y + 12, { width: width * 0.6 });
  doc.font('Helvetica-Bold').fontSize(16).text(money(Number(inv.total ?? 0) + previous), left + width * 0.5, y + 9, { width: width * 0.5 - 12, align: 'right' });
  y += 44;
  if (previous > 0) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#b42318').text('Tienes saldo pendiente. Ponte al día para evitar la suspensión del servicio.', left, y, { width });
    y = doc.y + 6;
  }

  // ── Pie ──
  if (issuer.receiptFooter) {
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(pdfText(issuer.receiptFooter), left, y, { width });
    y = doc.y + 4;
  }
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(pdfText(`Ref. de pago: ${s.code ?? ''}-${inv.number}`), left, y, { width });
  if (inv.electronic?.cufe) {
    doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(`Documento electrónico ${inv.electronic.number ?? ''} · CUFE/CUDE: ${inv.electronic.cufe}`, left, doc.y + 4, { width });
  }

  if (inv.status === 'void') {
    doc.save();
    doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.font('Helvetica-Bold').fontSize(90).fillColor('#b42318').opacity(0.15)
      .text('ANULADA', 0, doc.page.height / 2 - 50, { width: doc.page.width, align: 'center' });
    doc.restore();
  }
}
