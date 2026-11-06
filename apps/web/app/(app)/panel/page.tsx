'use client';

import { useEffect, useState } from 'react';
import { currentPeriod } from '@agua-mata/shared';
import { api } from '@/lib/api';
import { useMe } from '@/components/app-shell';
import { fmtMoney, fmtNumber, PageHeader, Stat } from '@/components/ui';

interface Dashboard {
  subscribers: number;
  compliancePending: number;
  readings: { period: string; activeMeters: number; read: number; pending: number; anomalies: Record<string, number>; totalM3: number };
  collected: { amount: number; count: number };
  receivables: number;
}

export default function PanelPage() {
  const { me } = useMe();
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');
  const period = currentPeriod();

  useEffect(() => {
    api<Dashboard>(`/dashboard?period=${period}`).then(setData).catch((e) => setError(e.message));
  }, [period]);

  const max = me.entitlements.limits.max_subscribers;
  const r = data?.readings;
  const anomalies = r ? Object.entries(r.anomalies).filter(([k]) => k !== 'estimated').reduce((a, [, v]) => a + v, 0) : 0;

  return (
    <>
      <PageHeader title="Inicio" description={`${me.organization.municipality}, ${me.organization.department} · Período ${period}`} />
      {error && <div className="alert alert-danger">{error}</div>}
      <div className="grid-stats">
        <Stat
          label="Suscriptores"
          value={fmtNumber(data?.subscribers)}
          sub={max !== undefined && max !== -1 ? `de ${fmtNumber(max)} en tu plan` : 'Sin límite en tu plan'}
          progress={max && max > 0 && data ? data.subscribers / max : undefined}
        />
        <Stat
          label={`Lecturas ${period}`}
          value={r ? `${fmtNumber(r.read)} / ${fmtNumber(r.activeMeters)}` : '—'}
          sub={r ? `${fmtNumber(r.pending)} pendientes` : undefined}
          progress={r && r.activeMeters ? r.read / r.activeMeters : undefined}
        />
        <Stat label="Consumo del período" value={r ? `${fmtNumber(r.totalM3, 1)} m³` : '—'} sub={r?.anomalies.estimated ? `${r.anomalies.estimated} estimadas` : undefined} />
        <Stat label="Recaudo del mes" value={fmtMoney(data?.collected.amount)} sub={data ? `${fmtNumber(data.collected.count)} pagos` : undefined} />
        <Stat label="Cartera pendiente" value={fmtMoney(data?.receivables)} sub={<a href="/cartera">Ver cartera</a>} />
        <Stat label="Para revisar" value={fmtNumber(anomalies)} sub="Lecturas con desviación o sin consumo" />
        <Stat label="Obligaciones pendientes" value={fmtNumber(data?.compliancePending)} sub={<a href="/configuracion?paso=compliance">Ver obligaciones</a>} />
      </div>

      <section className="card stack" style={{ marginTop: 20 }}>
        <h2>Accesos rápidos</h2>
        <div className="row">
          <a className="btn" href="/lecturas">Registrar lecturas</a>
          <a className="btn btn-secondary" href="/recaudo">Registrar pago</a>
          <a className="btn btn-secondary" href="/suscriptores">Ver suscriptores</a>
          <a className="btn btn-secondary" href="/medidores">Instalar medidor</a>
        </div>
      </section>
    </>
  );
}
