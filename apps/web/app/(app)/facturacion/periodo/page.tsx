'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { isAdminRole, useMe } from '@/components/app-shell';
import { ConfirmModal, Modal } from '@/components/modal';
import { AnomalyBadge, errorText, fmtMoney, fmtNumber, Icon, PageHeader, Stat } from '@/components/ui';
import { EInvoicePanel } from '@/components/einvoice-panel';

const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const FLAG: Record<string, [string, string]> = { sin_lectura: ['Sin lectura', 'badge-warn'], sin_medidor: ['Sin medidor', 'badge-info'] };

export default function PeriodoPage() {
  const { me } = useMe();
  const [params, setParams] = useState<{ p: string; faltantes: string; aforo: string } | null>(null);
  const [issued, setIssued] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState('');
  const [issueOpen, setIssueOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState('');
  const today = new Date().toISOString().slice(0, 10);
  const [dates, setDates] = useState({ issueDate: today, dueDate: addDays(today, 15) });
  const canBill = isAdminRole(me.role);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setParams({ p: q.get('p') ?? '', faltantes: q.get('faltantes') ?? 'block', aforo: q.get('aforo') ?? '' });
  }, []);

  const options = params && { missingReadings: params.faltantes === 'fixed_only' ? 'fixed_only' : 'block', unmeteredConsumptionM3: params.aforo ? Number(params.aforo) : null };

  const load = useCallback(async () => {
    if (!params?.p) return;
    setError('');
    try {
      const bp = await api(`/billing/periods/${params.p}`).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
      if (bp?.status === 'issued') { setIssued(bp); setPreview(null); return; }
      setIssued(null);
      if (canBill) setPreview(await api('/billing/preview', { method: 'POST', body: JSON.stringify({ period: params.p, options, issueDate: dates.issueDate }) }));
    } catch (e) {
      setError(errorText(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, canBill, dates.issueDate]);
  useEffect(() => { load(); }, [load]);

  async function issue(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setModalError('');
    try {
      await api('/billing/issue', { method: 'POST', body: JSON.stringify({ period: params!.p, options, ...dates }) });
      setIssueOpen(false);
      await load();
    } catch (err) {
      setModalError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function voidPeriod(reason: string) {
    setBusy(true);
    setModalError('');
    try {
      await api(`/billing/periods/${params!.p}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
      setVoidOpen(false);
      await load();
    } catch (err) {
      setModalError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!params) return null;
  const back = <a className="btn btn-ghost no-print" href="/facturacion">← Facturación</a>;

  // ───── Período ya emitido ─────
  if (issued) {
    const active = issued.invoices.filter((i: any) => i.status !== 'void');
    return (
      <>
        <PageHeader
          title={`Facturación ${issued.period}`}
          description={`Emitida el ${issued.issueDate.slice(0, 10)} · vence el ${issued.dueDate.slice(0, 10)} · ${issued.tariff?.name ?? ''}`}
          actions={<>
            {back}
            <a className="btn btn-secondary" href={`/facturacion/recibos?p=${issued.period}`} target="_blank" rel="noreferrer"><Icon name="printer" /> Imprimir todos</a>
            {canBill && <button className="btn btn-danger" onClick={() => { setModalError(''); setVoidOpen(true); }}>Anular facturación</button>}
          </>}
        />
        <div className="grid-stats" style={{ marginBottom: 16 }}>
          <Stat label="Facturas" value={fmtNumber(active.length)} />
          <Stat label="Total facturado" value={fmtMoney(issued.totalAmount)} />
          <Stat label="Subsidios" value={fmtMoney(issued.subsidyAmount)} />
          <Stat label="Contribuciones" value={fmtMoney(issued.contributionAmount)} />
        </div>
        {canBill && <EInvoicePanel period={issued.period} />}
        <section className="card card-flush">
          <div className="table-wrap">
            <table>
              <thead><tr><th>N.º</th><th>Suscriptor</th><th className="right">Consumo</th><th className="right">Subsidio</th><th className="right">Contribución</th><th className="right">Total</th><th>Estado</th><th></th></tr></thead>
              <tbody>
                {issued.invoices.map((i: any) => (
                  <tr key={i.id}>
                    <td className="mono">{i.number}</td>
                    <td><span className="mono">{i.subscriberSnapshot.code}</span> · {i.subscriberSnapshot.fullName}</td>
                    <td className="right mono">{fmtNumber(Number(i.consumptionM3), 2)} m³</td>
                    <td className="right mono">{Number(i.subsidyAmount) ? fmtMoney(i.subsidyAmount) : '—'}</td>
                    <td className="right mono">{Number(i.contributionAmount) ? fmtMoney(i.contributionAmount) : '—'}</td>
                    <td className="right mono"><strong>{fmtMoney(i.total)}</strong></td>
                    <td><span className={`badge ${i.status === 'void' ? 'badge-danger' : i.status === 'paid' ? 'badge-ok' : i.status === 'partial' ? 'badge-warn' : ''}`}>{{ void: 'Anulada', paid: 'Pagada', partial: 'Abonada' }[i.status as string] ?? 'Emitida'}</span></td>
                    <td className="right"><a className="btn btn-secondary btn-sm" href={`/facturacion/recibo?id=${i.id}`}>Ver recibo</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <ConfirmModal
          open={voidOpen}
          onClose={() => setVoidOpen(false)}
          onConfirm={voidPeriod}
          danger
          busy={busy}
          error={modalError}
          title={`Anular facturación ${issued.period}`}
          confirmLabel="Anular facturas"
          reasonLabel="Motivo de la anulación (queda en la auditoría)"
          message={<p>Se anularán <strong>{active.length} facturas</strong> y se desbloquearán las lecturas para corregirlas. Al volver a emitir, las facturas recibirán números nuevos.</p>}
        />
      </>
    );
  }

  // ───── Previsualización ─────
  return (
    <>
      <PageHeader
        title={`Previsualización ${params.p}`}
        description={<>Así quedarían las facturas. Nada se ha guardado todavía.{' '}
          <label className="row" style={{ display: 'inline-flex', gap: 6, marginTop: 8 }}>
            <span className="small">Fecha de expedición (los intereses se calculan hasta este día):</span>
            <input type="date" value={dates.issueDate} onChange={(e) => setDates({ issueDate: e.target.value, dueDate: addDays(e.target.value, 15) })} style={{ width: 'auto' }} />
          </label></>}
        actions={<>{back}{preview?.canIssue && <button className="btn" onClick={() => { setModalError(''); setIssueOpen(true); }}>Emitir {fmtNumber(preview.totals.invoices)} facturas</button>}</>}
      />
      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}
      {!canBill && <div className="alert alert-info">Solo los administradores pueden facturar.</div>}
      {preview && (
        <>
          {preview.warnings.missingReadings.length > 0 && (
            <div className={`alert ${options?.missingReadings === 'block' ? 'alert-danger' : 'alert-warn'}`} style={{ marginBottom: 12 }}>
              {preview.warnings.missingReadings.length} medidores no tienen lectura en {params.p}
              {options?.missingReadings === 'block'
                ? <>: <a href={`/lecturas`}>regístralas</a> o vuelve a facturar eligiendo «solo cargo fijo».</>
                : ': se les facturará solo el cargo fijo.'}
              <div className="small" style={{ marginTop: 4 }}>{preview.warnings.missingReadings.slice(0, 12).map((m: any) => m.code).join(', ')}{preview.warnings.missingReadings.length > 12 ? '…' : ''}</div>
            </div>
          )}
          {preview.warnings.toReview > 0 && (
            <div className="alert alert-warn" style={{ marginBottom: 12 }}>
              {preview.warnings.toReview} lecturas tienen desviaciones (consumo alto, lectura menor o sin consumo). <a href="/lecturas">Revísalas</a> antes de emitir si es necesario.
            </div>
          )}
          <div className="grid-stats" style={{ marginBottom: 16 }}>
            <Stat label="Facturas" value={fmtNumber(preview.totals.invoices)} sub={`Tarifa: ${preview.tariff.name}`} />
            <Stat label="Total a facturar" value={fmtMoney(preview.totals.total)} />
            <Stat label="Subsidios" value={fmtMoney(preview.totals.subsidy)} />
            <Stat label="Contribuciones" value={fmtMoney(preview.totals.contribution)} />
            {(preview.totals.interest > 0 || preview.totals.charges > 0) && (
              <Stat label="Intereses y cargos" value={fmtMoney(preview.totals.interest + preview.totals.charges)} sub={`Mora ${fmtMoney(preview.totals.interest)} · cargos ${fmtMoney(preview.totals.charges)}`} />
            )}
            <Stat label="Consumo" value={`${fmtNumber(preview.totals.consumptionM3, 1)} m³`} sub={preview.warnings.unmetered ? `${preview.warnings.unmetered} sin medidor` : undefined} />
          </div>
          <section className="card card-flush">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Suscriptor</th><th>Uso / estrato</th><th className="right">Consumo</th><th>Lectura</th><th className="right">Servicio</th><th className="right">Subsidio</th><th className="right">Contribución</th><th className="right">Mora y cargos</th><th className="right">Total</th></tr></thead>
                <tbody>
                  {preview.rows.map((r: any) => {
                    const flag = FLAG[r.flag];
                    return (
                      <tr key={r.subscriberId}>
                        <td><span className="mono">{r.code}</span> · {r.fullName}</td>
                        <td className="small">{r.usage === 'residencial' ? `Estrato ${r.stratum ?? '—'}` : r.usage}</td>
                        <td className="right mono">{fmtNumber(r.consumptionM3, 2)} m³</td>
                        <td>{flag ? <span className={`badge ${flag[1]}`}>{flag[0]}</span> : <AnomalyBadge anomaly={r.anomaly} />}</td>
                        <td className="right mono">{fmtMoney(r.subtotal)}</td>
                        <td className="right mono">{r.subsidy ? fmtMoney(r.subsidy) : '—'}</td>
                        <td className="right mono">{r.contribution ? fmtMoney(r.contribution) : '—'}</td>
                        <td className="right mono">{r.interest + r.charges ? fmtMoney(r.interest + r.charges) : '—'}</td>
                        <td className="right mono"><strong>{fmtMoney(r.total)}</strong></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <Modal
        open={issueOpen}
        onClose={() => setIssueOpen(false)}
        title={`Emitir facturación ${params.p}`}
        footer={<><button className="btn btn-secondary" onClick={() => setIssueOpen(false)}>Cancelar</button><button className="btn" type="submit" form="issue-form" disabled={busy}>{busy ? 'Emitiendo…' : 'Emitir facturas'}</button></>}
      >
        <form id="issue-form" className="stack" onSubmit={issue}>
          <p>
            Se emitirán <strong>{fmtNumber(preview?.totals.invoices)} facturas</strong> por <strong>{fmtMoney(preview?.totals.total)}</strong>.
            Las lecturas del período quedarán bloqueadas.
          </p>
          <div className="grid2">
            <label className="field">Fecha de expedición<input type="date" value={dates.issueDate} onChange={(e) => setDates({ issueDate: e.target.value, dueDate: addDays(e.target.value, 15) })} required /></label>
            <label className="field">Pago oportuno hasta<input type="date" value={dates.dueDate} min={dates.issueDate} onChange={(e) => setDates({ ...dates, dueDate: e.target.value })} required /></label>
          </div>
          {modalError && <div className="alert alert-danger">{modalError}</div>}
        </form>
      </Modal>
    </>
  );
}
