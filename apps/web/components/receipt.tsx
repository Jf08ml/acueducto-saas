import { READING_OBSERVATIONS, USAGES } from '@agua-mata/shared';
import { API_URL } from '@/lib/api';
import { brandStyle, fmtMoney, fmtNumber } from './ui';

export interface Issuer {
  id: string; name: string; legalName: string; nit: string; municipality: string; department: string;
  contactPhone: string; contactEmail: string;
  branding: { primaryColor?: string; receiptFooter?: string; hasLogo: boolean };
}

const OBS = Object.fromEntries(READING_OBSERVATIONS) as Record<string, string>;
const USAGE = Object.fromEntries(USAGES) as Record<string, string>;
const date = (d: string) => new Date(d).toLocaleDateString('es-CO', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });

/** Recibo del servicio de acueducto, con la marca del acueducto. Listo para imprimir o guardar como PDF. */
export function Receipt({ issuer, invoice }: { issuer: Issuer; invoice: any }) {
  const s = invoice.subscriberSnapshot;
  const r = invoice.readingSnapshot;
  const history: { period: string; m3: number }[] = [...(r.history ?? [])].reverse();
  const bars = [...history, { period: invoice.period, m3: Number(invoice.consumptionM3), current: true }];
  const max = Math.max(1, ...bars.map((b) => b.m3));

  return (
    <article className={`receipt ${invoice.status === 'void' ? 'void' : ''}`} style={brandStyle(issuer.branding.primaryColor)}>
      <header className="r-head">
        <div className="row" style={{ alignItems: 'flex-start' }}>
          {issuer.branding.hasLogo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="r-logo" src={`${API_URL}/public/orgs/${issuer.id}/logo`} alt="" />
          )}
          <div>
            <h1>{issuer.name}</h1>
            <div>{issuer.legalName} · NIT {issuer.nit}</div>
            <div>{issuer.municipality}, {issuer.department} · Tel. {issuer.contactPhone} · {issuer.contactEmail}</div>
          </div>
        </div>
        <div className="r-num">
          <span className="r-label">Factura de servicio de acueducto</span>
          <strong>N.º {invoice.number}</strong>
          <span>Período {invoice.period}</span>
        </div>
      </header>

      <section className="r-grid">
        <div><div className="r-label">Suscriptor</div><strong>{s.fullName}</strong><div>Doc. {s.documentNumber}</div></div>
        <div><div className="r-label">Código / dirección</div><strong>{s.code}</strong><div>{s.address}</div></div>
        <div><div className="r-label">Uso / estrato</div><div>{USAGE[s.usage] ?? s.usage}{s.stratum ? ` · Estrato ${s.stratum}` : ''}</div></div>
        <div><div className="r-label">Expedición / pago oportuno</div><div>{date(invoice.issueDate)} · <strong>{date(invoice.dueDate)}</strong></div></div>
      </section>

      <section className="r-grid">
        <div>
          <div className="r-label">Medidor</div>
          <div>{r.meterSerial ?? 'Sin medidor'}</div>
          {r.flag === 'ok' && (
            <div>Anterior {fmtNumber(r.previousValue, 2)} · Actual {r.currentValue === null ? '—' : fmtNumber(r.currentValue, 2)}</div>
          )}
          {r.observation && <div>{OBS[r.observation] ?? r.observation}{r.isEstimated ? ' (consumo estimado)' : ''}</div>}
          {r.flag === 'sin_lectura' && <div>Sin lectura en el período: se factura solo el cargo fijo</div>}
        </div>
        <div>
          <div className="r-label">Consumo del período</div>
          <strong style={{ fontSize: 18 }}>{fmtNumber(Number(invoice.consumptionM3), 2)} m³</strong>
        </div>
        <div style={{ gridColumn: 'span 2', minWidth: 240 }}>
          <div className="r-label">Historial de consumo (m³)</div>
          <div className="r-bars">
            {bars.map((b) => (
              <div key={b.period} className={'current' in b ? 'current' : ''}>
                <span>{fmtNumber(b.m3)}</span>
                <span style={{ height: `${Math.max(2, (b.m3 / max) * 48)}px` }} aria-hidden="true" />
                <span>{b.period.slice(5)}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <table>
        <thead><tr><th>Concepto</th><th className="right">Cantidad</th><th className="right">Valor unitario</th><th className="right">Valor</th></tr></thead>
        <tbody>
          {invoice.lines.map((l: any) => (
            <tr key={l.id}>
              <td>{l.description}</td>
              <td className="right mono">{l.concept.startsWith('consumo') ? `${fmtNumber(Number(l.quantity), 2)} m³` : ''}</td>
              <td className="right mono">{l.concept.startsWith('consumo') || l.concept === 'cargo_fijo' ? fmtMoney(l.unitPrice) : ''}</td>
              <td className="right mono">{fmtMoney(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {Number(invoice.previousBalance) > 0 && (
        <table>
          <tbody>
            <tr><td>Valor de este período</td><td className="right mono">{fmtMoney(invoice.total)}</td></tr>
            <tr><td><strong>Saldo anterior pendiente</strong> (facturas vencidas o por pagar)</td><td className="right mono"><strong>{fmtMoney(invoice.previousBalance)}</strong></td></tr>
          </tbody>
        </table>
      )}

      <div className="r-total">
        <span>Total a pagar · antes del {date(invoice.dueDate)}</span>
        <strong>{fmtMoney(Number(invoice.total) + Number(invoice.previousBalance ?? 0))}</strong>
      </div>
      {Number(invoice.previousBalance) > 0 && (
        <p className="small" style={{ color: '#b42318', margin: 0 }}>
          Tienes saldo pendiente. Ponte al día para evitar la suspensión del servicio.
        </p>
      )}

      <footer className="r-foot">
        {issuer.branding.receiptFooter && <p>{issuer.branding.receiptFooter}</p>}
        <p>Ref. de pago: {s.code}-{invoice.number}</p>
        {invoice.electronicDocument?.status === 'accepted' && (
          <p className="small" style={{ wordBreak: 'break-all' }}>
            Documento electrónico {invoice.electronicDocument.prefix}{invoice.electronicDocument.number}
            {invoice.electronicDocument.environment !== 'produccion' ? ' (habilitación, sin validez)' : ''} · CUFE/CUDE: {invoice.electronicDocument.documentKey}
          </p>
        )}
      </footer>
    </article>
  );
}
