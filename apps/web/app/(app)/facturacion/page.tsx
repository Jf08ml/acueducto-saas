'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { currentPeriod } from '@agua-mata/shared';
import { api } from '@/lib/api';
import { isAdminRole, useMe } from '@/components/app-shell';
import { Modal } from '@/components/modal';
import { Empty, errorText, fmtMoney, fmtNumber, Icon, PageHeader } from '@/components/ui';

function periodsBack(n: number) {
  const out: string[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < n; i++) { out.push(currentPeriod(d)); d.setMonth(d.getMonth() - 1); }
  return out;
}

export default function FacturacionPage() {
  const router = useRouter();
  const { me } = useMe();
  const [periods, setPeriods] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ period: currentPeriod(), missingReadings: 'block', aforo: '' });
  const canBill = isAdminRole(me.role) && me.entitlements.features.billing !== false;

  useEffect(() => { api<any[]>('/billing/periods').then(setPeriods).catch((e) => setError(errorText(e))); }, []);

  function goPreview(e: React.FormEvent) {
    e.preventDefault();
    const q = new URLSearchParams({ p: form.period, faltantes: form.missingReadings, ...(form.aforo ? { aforo: form.aforo } : {}) });
    router.push(`/facturacion/periodo?${q}`);
  }

  return (
    <>
      <PageHeader
        title="Facturación"
        description="Factura cada período con las lecturas registradas y la tarifa vigente."
        actions={canBill && <button className="btn" onClick={() => setOpen(true)}><Icon name="plus" /> Facturar período</button>}
      />
      {error && <div className="alert alert-danger">{error}</div>}

      <section className="card card-flush">
        {periods === null ? <p className="muted" style={{ padding: 20 }}>Cargando…</p> : periods.length === 0 ? (
          <Empty title="Aún no has facturado ningún período">
            {canBill && <button className="btn" onClick={() => setOpen(true)}>Facturar el primer período</button>}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Período</th><th>Estado</th><th className="right">Facturas</th><th className="right">Consumo</th><th className="right">Subsidios</th><th className="right">Contribuciones</th><th className="right">Total facturado</th><th>Vence</th></tr></thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => router.push(`/facturacion/periodo?p=${p.period}`)}>
                    <td><a href={`/facturacion/periodo?p=${p.period}`}><strong>{p.period}</strong></a><div className="small muted">{p.tariff?.name}</div></td>
                    <td><span className={`badge ${p.status === 'issued' ? 'badge-ok' : 'badge-danger'}`}>{p.status === 'issued' ? 'Emitida' : 'Anulada'}</span></td>
                    <td className="right mono">{fmtNumber(p.invoiceCount)}</td>
                    <td className="right mono">{fmtNumber(Number(p.consumptionM3), 1)} m³</td>
                    <td className="right mono">{fmtMoney(p.subsidyAmount)}</td>
                    <td className="right mono">{fmtMoney(p.contributionAmount)}</td>
                    <td className="right mono"><strong>{fmtMoney(p.totalAmount)}</strong></td>
                    <td>{p.dueDate.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Facturar período"
        footer={<><button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancelar</button><button className="btn" type="submit" form="bill-form">Ver previsualización</button></>}
      >
        <form id="bill-form" className="stack" onSubmit={goPreview}>
          <p className="muted">Primero verás cómo quedan las facturas. Nada se guarda hasta que confirmes la emisión.</p>
          <label className="field">Período
            <select value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })}>
              {periodsBack(12).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <div className="stack-sm">
            <span className="small" style={{ fontWeight: 500 }}>Medidores sin lectura en el período</span>
            <label className="radio-card">
              <input type="radio" name="missing" checked={form.missingReadings === 'block'} onChange={() => setForm({ ...form, missingReadings: 'block' })} />
              <span><strong>No facturar hasta completar las lecturas</strong><br /><span className="muted">Recomendado: la emisión se bloquea si falta alguna.</span></span>
            </label>
            <label className="radio-card">
              <input type="radio" name="missing" checked={form.missingReadings === 'fixed_only'} onChange={() => setForm({ ...form, missingReadings: 'fixed_only' })} />
              <span><strong>Facturar solo el cargo fijo</strong><br /><span className="muted">El consumo de esos suscriptores se cobrará cuando se registre la lectura.</span></span>
            </label>
          </div>
          <label className="field">Consumo de suscriptores sin medidor (m³, aforo)
            <span className="hint">Déjalo vacío para cobrarles solo el cargo fijo.</span>
            <input inputMode="numeric" value={form.aforo} onChange={(e) => setForm({ ...form, aforo: e.target.value.replace(/[^\d.]/g, '') })} placeholder="Ej. 16" />
          </label>
        </form>
      </Modal>
    </>
  );
}
