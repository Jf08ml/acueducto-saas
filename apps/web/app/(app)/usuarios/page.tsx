'use client';

import { useCallback, useEffect, useState } from 'react';
import { canAssignRole, canManageMember, ROLE_INFO, ROLE_LABEL } from '@agua-mata/shared';
import { api } from '@/lib/api';
import { useMe } from '@/components/app-shell';
import { ConfirmModal, Modal } from '@/components/modal';
import { Empty, errorText, fmtNumber, Icon, PageHeader } from '@/components/ui';

const ROLE_BADGE: Record<string, string> = { owner: 'badge-info', admin: 'badge-info', operator: '', reader: '' };
const when = (d?: string | null) => (d ? new Date(d).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }) : 'Nunca');

function RolePicker({ value, onChange, actorRole }: { value: string; onChange: (r: string) => void; actorRole: string }) {
  return (
    <div className="stack-sm" role="radiogroup" aria-label="Rol">
      {ROLE_INFO.filter((r) => canAssignRole(actorRole, r.role)).map((r) => (
        <label key={r.role} className="radio-card">
          <input type="radio" name="role" checked={value === r.role} onChange={() => onChange(r.role)} />
          <span><strong>{r.label}</strong><br /><span className="muted">{r.description}</span></span>
        </label>
      ))}
    </div>
  );
}

/** Enlace de invitación para compartir a mano mientras no haya correo configurado. */
function LinkShare({ link, email, orgName }: { link: { inviteUrl: string; expiresAt: string; emailSent: boolean; emailError?: string }; email: string; orgName: string }) {
  const [copied, setCopied] = useState(false);
  const text = `Hola, te invito a ${orgName} en AguaMata. Crea tu acceso aquí: ${link.inviteUrl}`;
  return (
    <div className="stack">
      <div className="alert alert-ok">Invitación lista para <strong>{email}</strong>.</div>
      {link.emailSent
        ? <p className="small">Le enviamos un correo con el enlace. También puedes compartirlo por WhatsApp; solo se muestra ahora.</p>
        : link.emailError
          ? <div className="alert alert-warn small">No se pudo enviar el correo. Comparte el enlace por WhatsApp o cópialo; solo se muestra ahora.</div>
          : <p className="muted small">El envío por correo no está configurado en esta instalación. Comparte el enlace por WhatsApp o cópialo; solo se muestra ahora.</p>}
      <code style={{ display: 'block', padding: 10 }}>{link.inviteUrl}</code>
      <div className="row">
        <button className="btn btn-secondary" onClick={() => navigator.clipboard?.writeText(link.inviteUrl).then(() => setCopied(true))}>{copied ? '¡Copiado!' : 'Copiar enlace'}</button>
        <a className="btn btn-secondary" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">Compartir por WhatsApp</a>
      </div>
      <p className="small muted">Vence el {when(link.expiresAt)}. Si se pierde, usa «Reenviar» para generar uno nuevo; el anterior deja de servir.</p>
    </div>
  );
}

export default function UsuariosPage() {
  const { me } = useMe();
  const [data, setData] = useState<{ members: any[]; invitations: any[] } | null>(null);
  const [error, setError] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: '', role: 'operator' });
  const [link, setLink] = useState<{ inviteUrl: string; expiresAt: string; emailSent: boolean; emailError?: string; email: string } | null>(null);
  const [editing, setEditing] = useState<any>(null);
  const [editForm, setEditForm] = useState({ role: '', status: '' });
  const [removing, setRemoving] = useState<any>(null);
  const [revoking, setRevoking] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState('');

  const load = useCallback(() => api('/team').then(setData).catch((e) => setError(errorText(e))), []);
  useEffect(() => { load(); }, [load]);

  async function run<T>(fn: () => Promise<T>, after: (r: T) => void) {
    setBusy(true);
    setModalError('');
    try {
      const r = await fn();
      after(r);
      load();
    } catch (e) {
      setModalError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const sendInvite = (e: React.FormEvent) => {
    e.preventDefault();
    run(() => api('/team/invitations', { method: 'POST', body: JSON.stringify(inviteForm) }), (r: any) => setLink({ ...r, email: r.email }));
  };
  const saveMember = (e: React.FormEvent) => {
    e.preventDefault();
    const body: any = {};
    if (editForm.role !== editing.role) body.role = editForm.role;
    if (editForm.status !== editing.status) body.status = editForm.status;
    if (!Object.keys(body).length) { setEditing(null); return; }
    run(() => api(`/team/members/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) }), () => setEditing(null));
  };
  const resend = (inv: any) => {
    setModalError('');
    run(() => api(`/team/invitations/${inv.id}/resend`, { method: 'POST' }), (r: any) => { setLink({ ...r, email: inv.email }); setInviteOpen(true); });
  };

  const active = data?.members.filter((m) => m.status === 'active').length ?? 0;
  const pending = data?.invitations.filter((i) => !i.expired).length ?? 0;
  const max = me.entitlements.limits.max_admin_users;

  return (
    <>
      <PageHeader
        title="Usuarios"
        description={`${fmtNumber(active)} con acceso${pending ? ` · ${pending} invitaciones pendientes` : ''}${max !== undefined && max !== -1 ? ` · tu plan permite ${max}` : ''}`}
        actions={<button className="btn" onClick={() => { setLink(null); setModalError(''); setInviteForm({ email: '', role: 'operator' }); setInviteOpen(true); }}><Icon name="plus" /> Invitar persona</button>}
      />
      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

      <section className="card card-flush" style={{ marginBottom: 16 }}>
        <div className="card-head"><h2>Personal</h2></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Persona</th><th>Rol</th><th>Estado</th><th>Último ingreso</th><th></th></tr></thead>
            <tbody>
              {data?.members.map((m) => {
                const self = m.id === me.membershipId;
                const manageable = canManageMember(me.role, m.role, self);
                return (
                  <tr key={m.id} style={m.status === 'disabled' ? { opacity: 0.6 } : undefined}>
                    <td><strong>{m.user.fullName}</strong>{self && <span className="badge" style={{ marginLeft: 6 }}>Tú</span>}<div className="small muted">{m.user.email}</div></td>
                    <td><span className={`badge ${ROLE_BADGE[m.role]}`}>{ROLE_LABEL[m.role]}</span></td>
                    <td><span className={`badge ${m.status === 'active' ? 'badge-ok' : 'badge-danger'}`}>{m.status === 'active' ? 'Activo' : 'Desactivado'}</span></td>
                    <td className="small">{when(m.user.lastLoginAt)}</td>
                    <td className="right">
                      {manageable && (
                        <span className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                          <button className="icon-btn" title="Editar acceso" aria-label={`Editar acceso de ${m.user.fullName}`} onClick={() => { setModalError(''); setEditForm({ role: m.role, status: m.status }); setEditing(m); }}><Icon name="edit" /></button>
                          <button className="btn btn-ghost btn-sm" onClick={() => { setModalError(''); setRemoving(m); }}>Quitar</button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card card-flush">
        <div className="card-head"><h2>Invitaciones pendientes</h2></div>
        {!data?.invitations.length ? <Empty title="No hay invitaciones pendientes" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Correo</th><th>Rol</th><th>Vence</th><th></th></tr></thead>
              <tbody>
                {data.invitations.map((i) => (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td>{ROLE_LABEL[i.role]}</td>
                    <td>{i.expired ? <span className="badge badge-danger">Vencida</span> : <span className="small">{when(i.expiresAt)}</span>}</td>
                    <td className="right">
                      <span className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                        {canAssignRole(me.role, i.role) && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => resend(i)}>Reenviar</button>}
                        <button className="btn btn-ghost btn-sm" onClick={() => { setModalError(''); setRevoking(i); }}>Cancelar</button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Modal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title={link ? 'Enlace de invitación' : 'Invitar persona'}
        footer={link
          ? <button className="btn" onClick={() => setInviteOpen(false)}>Listo</button>
          : <><button className="btn btn-secondary" onClick={() => setInviteOpen(false)}>Cancelar</button><button className="btn" type="submit" form="invite-form" disabled={busy}>Crear invitación</button></>}
      >
        {link ? <LinkShare link={link} email={link.email} orgName={me.organization.name} /> : (
          <form id="invite-form" className="stack" onSubmit={sendInvite}>
            <label className="field">Correo de la persona<input type="email" value={inviteForm.email} onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })} required autoFocus /></label>
            <RolePicker value={inviteForm.role} onChange={(role) => setInviteForm({ ...inviteForm, role })} actorRole={me.role} />
            {modalError && <div className="alert alert-danger">{modalError}</div>}
          </form>
        )}
      </Modal>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={`Acceso de ${editing?.user.fullName ?? ''}`}
        footer={<><button className="btn btn-secondary" onClick={() => setEditing(null)}>Cancelar</button><button className="btn" type="submit" form="member-form" disabled={busy}>Guardar</button></>}
      >
        {editing && (
          <form id="member-form" className="stack" onSubmit={saveMember}>
            <RolePicker value={editForm.role} onChange={(role) => setEditForm({ ...editForm, role })} actorRole={me.role} />
            <label className="field">Estado
              <select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}>
                <option value="active">Activo: puede ingresar</option>
                <option value="disabled">Desactivado: pierde el acceso de inmediato</option>
              </select>
            </label>
            {modalError && <div className="alert alert-danger">{modalError}</div>}
          </form>
        )}
      </Modal>

      <ConfirmModal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => run(() => api(`/team/members/${removing.id}`, { method: 'DELETE' }), () => setRemoving(null))}
        danger busy={busy} error={modalError}
        title="Quitar del acueducto"
        confirmLabel="Quitar"
        message={<p><strong>{removing?.user.fullName}</strong> perderá el acceso a este acueducto. Su cuenta y su historial en la auditoría se conservan. Si solo es temporal, mejor desactívalo.</p>}
      />
      <ConfirmModal
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        onConfirm={() => run(() => api(`/team/invitations/${revoking.id}`, { method: 'DELETE' }), () => setRevoking(null))}
        busy={busy} error={modalError}
        title="Cancelar invitación"
        confirmLabel="Cancelar invitación"
        message={<p>El enlace enviado a <strong>{revoking?.email}</strong> dejará de funcionar.</p>}
      />
    </>
  );
}
