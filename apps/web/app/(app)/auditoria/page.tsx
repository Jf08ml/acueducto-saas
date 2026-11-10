'use client';

import { useCallback, useEffect, useState } from 'react';
import { SUPPORT_SCOPE_LABEL, SUPPORT_STATUS_LABEL, supportGrantState } from '@agua-mata/shared';
import { api } from '@/lib/api';
import { useMe } from '@/components/app-shell';
import { AuditLog } from '@/components/audit-log';
import { ConfirmModal, Modal } from '@/components/modal';
import { errorText, PageHeader } from '@/components/ui';

const when = (d?: string | null) => (d ? new Date(d).toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'medium', timeStyle: 'short' }) : '—');
const STATE_BADGE: Record<string, string> = { pending: 'badge-warn', approved: 'badge-ok', rejected: '', revoked: '', expired: '' };

/** Seguridad y auditoría: accesos de soporte de AguaMata (aprobar, rechazar, revocar) y bitácora completa del acueducto. */
export default function AuditoriaPage() {
  const { me } = useMe();
  const [grants, setGrants] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deciding, setDeciding] = useState<{ grant: any; decision: 'approve' | 'reject' } | null>(null);
  const [revoking, setRevoking] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState('');

  const load = useCallback(async () => {
    try {
      setGrants(await api('/support/grants'));
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function run(fn: () => Promise<unknown>, done: string, close: () => void) {
    setBusy(true);
    setModalError('');
    try {
      await fn();
      close();
      setNotice(done);
      await load();
    } catch (e) {
      setModalError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const isSupport = Boolean((me as any).support);
  const pending = (grants ?? []).filter((g) => g.status === 'pending');
  const active = (grants ?? []).filter((g) => supportGrantState(g) === 'approved');
  const history = (grants ?? []).filter((g) => !pending.includes(g) && !active.includes(g));

  return (
    <div className="stack">
      <PageHeader title="Seguridad y auditoría" description="Quién entra a tu cuenta y qué hace. El soporte de AguaMata solo puede ver tus datos si tú lo apruebas." />
      {error && <div className="alert alert-danger">{error}</div>}
      {notice && <div className="alert alert-ok" role="status">{notice}</div>}

      <section className="card stack">
        <h2 style={{ margin: 0 }}>Accesos de soporte</h2>
        {grants === null ? <p className="muted">Cargando…</p> : grants.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Nadie de AguaMata ha pedido acceso a tu cuenta.</p>
        ) : (
          <>
            {pending.map((g) => (
              <div key={g.id} className="alert alert-warn stack-sm">
                <strong>{g.requestedBy} pide acceso a tu cuenta</strong>
                <span>Motivo: {g.reason}</span>
                <span className="small">Alcance: {SUPPORT_SCOPE_LABEL[g.scope]} · Durante {g.durationHours} hora(s) desde que lo apruebes · Pedido el {when(g.createdAt)}</span>
                {!isSupport && (
                  <div className="row">
                    <button className="btn btn-sm" onClick={() => { setModalError(''); setDeciding({ grant: g, decision: 'approve' }); }}>Aprobar</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => { setModalError(''); setDeciding({ grant: g, decision: 'reject' }); }}>Rechazar</button>
                  </div>
                )}
              </div>
            ))}
            {active.map((g) => (
              <div key={g.id} className="alert alert-info row-between">
                <span><strong>Acceso vigente</strong> de {g.requestedBy} ({SUPPORT_SCOPE_LABEL[g.scope].toLowerCase()}) hasta el {when(g.expiresAt)}. Cada consulta queda en la bitácora.</span>
                {!isSupport && <button className="btn btn-secondary btn-sm" onClick={() => { setModalError(''); setRevoking(g); }}>Cortar el acceso ahora</button>}
              </div>
            ))}
            {history.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Pedido</th><th>Quién</th><th>Motivo</th><th>Alcance</th><th>Estado</th></tr></thead>
                  <tbody>
                    {history.map((g) => {
                      const st = supportGrantState(g);
                      return (
                        <tr key={g.id}>
                          <td className="small">{when(g.createdAt)}</td>
                          <td className="small">{g.requestedBy}</td>
                          <td className="small">{g.reason}{g.decisionNote && <div className="muted">Respuesta: {g.decisionNote}</div>}</td>
                          <td className="small">{SUPPORT_SCOPE_LABEL[g.scope]}</td>
                          <td><span className={`badge ${STATE_BADGE[st] ?? ''}`}>{SUPPORT_STATUS_LABEL[st] ?? st}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      <AuditLog path="/audit" />

      <DecisionModal state={deciding} busy={busy} error={modalError} onClose={() => setDeciding(null)}
        onSubmit={(note) => deciding && run(
          () => api(`/support/grants/${deciding.grant.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: deciding.decision, ...(note ? { note } : {}) }) }),
          deciding.decision === 'approve' ? 'Acceso aprobado. Puedes cortarlo cuando quieras.' : 'Solicitud rechazada.',
          () => setDeciding(null),
        )} />
      <ConfirmModal open={revoking !== null} onClose={() => setRevoking(null)} busy={busy} error={modalError} danger
        title="Cortar el acceso de soporte" confirmLabel="Cortar ahora"
        message={<p>El soporte de AguaMata saldrá de tu cuenta de inmediato. Si lo necesita otra vez, tendrá que pedir un acceso nuevo.</p>}
        onConfirm={() => revoking && run(() => api(`/support/grants/${revoking.id}/revoke`, { method: 'POST' }), 'Acceso cortado.', () => setRevoking(null))} />
    </div>
  );
}

function DecisionModal({ state, busy, error, onClose, onSubmit }: {
  state: { grant: any; decision: 'approve' | 'reject' } | null; busy: boolean; error: string; onClose: () => void; onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  useEffect(() => { setNote(''); }, [state]);
  const approve = state?.decision === 'approve';
  return (
    <Modal open={state !== null} onClose={onClose} title={approve ? 'Aprobar acceso de soporte' : 'Rechazar acceso de soporte'}
      footer={<><button className="btn btn-secondary" onClick={onClose}>Cancelar</button><button className={`btn ${approve ? '' : 'btn-danger'}`} type="submit" form="decision-form" disabled={busy}>{approve ? 'Aprobar' : 'Rechazar'}</button></>}>
      {state && (
        <form id="decision-form" className="stack" onSubmit={(e) => { e.preventDefault(); onSubmit(note.trim()); }}>
          <p style={{ margin: 0 }}>
            {approve
              ? <>{state.grant.requestedBy} podrá <strong>{SUPPORT_SCOPE_LABEL[state.grant.scope].toLowerCase()}</strong> en tu cuenta durante <strong>{state.grant.durationHours} hora(s)</strong>. Cada consulta queda en la bitácora y puedes cortar el acceso cuando quieras.</>
              : <>{state.grant.requestedBy} no podrá entrar a tu cuenta.</>}
          </p>
          <label className="field">{approve ? 'Nota (opcional)' : 'Motivo (se le envía a soporte)'}
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} required={!approve} minLength={approve ? undefined : 3} maxLength={300} />
          </label>
          {error && <div className="alert alert-danger">{error}</div>}
        </form>
      )}
    </Modal>
  );
}
