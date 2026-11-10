'use client';

import { useCallback, useEffect, useState } from 'react';
import { EINVOICE_STATUS_LABEL } from '@agua-mata/shared';
import { api, waitForJob } from '@/lib/api';
import { errorText } from './ui';

const BADGE: Record<string, string> = { accepted: 'badge-ok', pending: 'badge-info', error: 'badge-danger', rejected: 'badge-danger', requires_credit_note: 'badge-warn', void: '' };

/** Estado de la facturación electrónica de un período, con reintento de lo que falló. */
export function EInvoicePanel({ period }: { period: string }) {
  const [st, setSt] = useState<any>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null);

  const load = useCallback(() => api(`/einvoice/periods/${period}`).then(setSt).catch(() => setSt(null)), [period]);
  useEffect(() => { load(); }, [load]);

  async function retry() {
    setBusy(0);
    setMsg(null);
    try {
      const job = await api<{ id: string }>(`/einvoice/periods/${period}/retry`, { method: 'POST' });
      const r = await waitForJob<any>(job.id, (j) => setBusy(j.progress));
      setMsg({ kind: r.errors || r.rejected ? 'warn' : 'ok', text: `Enviadas ${r.sent}: ${r.accepted} aceptadas${r.rejected ? `, ${r.rejected} rechazadas` : ''}${r.errors ? `, ${r.errors} con error` : ''}.` });
    } catch (e) {
      setMsg({ kind: 'danger', text: errorText(e) });
    } finally {
      setBusy(null);
      load();
    }
  }

  if (!st?.enabled && !Object.keys(st?.counts ?? {}).length) return null;
  const counts: Record<string, number> = st.counts ?? {};
  const pendingWork = (counts.pending ?? 0) + (counts.error ?? 0);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <section className="card stack-sm" style={{ marginBottom: 16 }}>
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Facturación electrónica</h2>
        {st.enabled && <button className="btn btn-secondary btn-sm" onClick={retry} disabled={busy !== null}>
          {busy !== null ? `Enviando… ${busy}%` : pendingWork || total === 0 ? 'Enviar pendientes' : 'Revisar de nuevo'}
        </button>}
      </div>
      {st.provider === 'simulated' && <div className="alert alert-warn small">Proveedor simulado (habilitación): los documentos no se transmiten a la DIAN y no tienen validez.</div>}
      {total === 0 ? <p className="muted small" style={{ margin: 0 }}>Aún no hay documentos electrónicos para este período.</p> : (
        <div className="row">
          {Object.entries(counts).map(([k, v]) => <span key={k} className={`badge ${BADGE[k] ?? ''}`}>{EINVOICE_STATUS_LABEL[k] ?? k}: {v}</span>)}
        </div>
      )}
      {st.problems?.length > 0 && (
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {st.problems.map((p: any) => (
            <li key={p.id}>
              {p.prefix}{p.number} · factura {p.invoice.number} ({p.invoice.subscriberSnapshot?.fullName}): {EINVOICE_STATUS_LABEL[p.status]}{p.lastError ? ` — ${p.lastError}` : ''}
            </li>
          ))}
        </ul>
      )}
      {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
    </section>
  );
}
