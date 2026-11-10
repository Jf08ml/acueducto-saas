import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Mercado Pago, Checkout Pro (API REST, sin SDK). El acueducto paga en la página de Mercado Pago
 * y vuelve a la plataforma. La confirmación llega por webhook y también se puede consultar al volver.
 *
 * Seguridad: un pago solo se da por bueno después de CONSULTARLO en la API de Mercado Pago con nuestro token
 * (estado aprobado, moneda COP, monto y referencia correctos). La firma del webhook se verifica además
 * cuando MP_WEBHOOK_SECRET está configurado.
 */

export interface MpPreferenceInput {
  invoiceId: string;
  title: string;
  amountCop: number;
  payerEmail?: string;
  notificationUrl?: string;
  backUrl: string;
}

export interface MpPayment {
  id: string;
  status: string; // approved | pending | in_process | rejected | cancelled | refunded | charged_back
  statusDetail?: string;
  amount: number;
  currency: string;
  externalReference: string | null;
  dateApproved?: string | null;
  methodId?: string | null;
}

export interface MercadoPagoApi {
  readonly enabled: boolean;
  createPreference(input: MpPreferenceInput): Promise<{ id: string; url: string }>;
  getPayment(id: string): Promise<MpPayment | null>;
}

const BASE = 'https://api.mercadopago.com';

export class MercadoPagoClient implements MercadoPagoApi {
  constructor(private readonly token = process.env.MP_ACCESS_TOKEN ?? '') {}

  get enabled() {
    return Boolean(this.token);
  }

  private async call(path: string, init: RequestInit = {}) {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  async createPreference(input: MpPreferenceInput) {
    const sandbox = this.token.startsWith('TEST-');
    const { status, body } = await this.call('/checkout/preferences', {
      method: 'POST',
      headers: { 'X-Idempotency-Key': `${input.invoiceId}-${Date.now()}` },
      body: JSON.stringify({
        items: [{ id: input.invoiceId, title: input.title, quantity: 1, currency_id: 'COP', unit_price: input.amountCop }],
        external_reference: input.invoiceId,
        payer: input.payerEmail ? { email: input.payerEmail } : undefined,
        notification_url: input.notificationUrl,
        back_urls: { success: input.backUrl, pending: input.backUrl, failure: input.backUrl },
        // Mercado Pago solo acepta el regreso automático con direcciones https.
        auto_return: input.backUrl.startsWith('https://') ? 'approved' : undefined,
        statement_descriptor: 'AGUAMATA',
        metadata: { invoice_id: input.invoiceId },
      }),
    });
    if (status >= 300 || !body?.id) throw new Error(`Mercado Pago rechazó la preferencia (${status}): ${body?.message ?? ''}`);
    return { id: String(body.id), url: String(sandbox && body.sandbox_init_point ? body.sandbox_init_point : body.init_point) };
  }

  async getPayment(id: string): Promise<MpPayment | null> {
    if (!/^\d{1,30}$/.test(id)) return null;
    const { status, body } = await this.call(`/v1/payments/${id}`);
    if (status === 404) return null;
    if (status >= 300 || !body) throw new Error(`No se pudo consultar el pago ${id} en Mercado Pago (${status})`);
    return {
      id: String(body.id),
      status: String(body.status),
      statusDetail: body.status_detail,
      amount: Number(body.transaction_amount),
      currency: String(body.currency_id),
      externalReference: body.external_reference ?? null,
      dateApproved: body.date_approved ?? null,
      methodId: body.payment_method_id ?? null,
    };
  }
}

/**
 * Verifica la firma del webhook (encabezado x-signature: "ts=...,v1=...").
 * Plantilla firmada: "id:{data.id};request-id:{x-request-id};ts:{ts};" con HMAC-SHA256 y la clave secreta del webhook.
 */
export function verifyMpSignature(opts: { signature?: string; requestId?: string; dataId?: string; secret: string }): boolean {
  const { signature, requestId, secret } = opts;
  if (!signature || !secret) return false;
  const parts = Object.fromEntries(signature.split(',').map((p) => p.trim().split('=', 2) as [string, string]));
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1 || !/^[0-9a-f]{64}$/i.test(v1)) return false;
  const dataId = opts.dataId && /^[a-z0-9]+$/i.test(opts.dataId) ? opts.dataId.toLowerCase() : opts.dataId;
  let manifest = '';
  if (dataId) manifest += `id:${dataId};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${ts};`;
  const expected = createHmac('sha256', secret).update(manifest).digest('hex');
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(v1.toLowerCase(), 'hex'));
}
