'use client';

import { useEffect, useState } from 'react';
import { api, API_URL, setToken } from '@/lib/api';
import { brandStyle, errorText, Icon } from '@/components/ui';

/** Aceptar una invitación (pública): crea la cuenta o vincula una existente con su contraseña. */
export default function InvitacionPage() {
  const [token, setTok] = useState('');
  const [info, setInfo] = useState<any>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ fullName: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('token') ?? '';
    setTok(t);
    if (!t) { setError('El enlace está incompleto.'); return; }
    api(`/public/invitations/${encodeURIComponent(t)}`).then(setInfo).catch((e) => setError(errorText(e)));
  }, []);

  async function accept(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!info.userExists && form.password !== form.confirm) { setError('Las contraseñas no coinciden'); return; }
    setBusy(true);
    try {
      await api(`/public/invitations/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        body: JSON.stringify({ password: form.password, ...(info.userExists ? {} : { fullName: form.fullName }) }),
      });
      setToken(null);
      // Window.history: quitar el token de la barra de direcciones.
      window.history.replaceState(null, '', '/invitacion');
      setDone(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const org = info?.organization;
  return (
    <div className="auth" style={brandStyle(org?.branding.primaryColor)}>
      <section className="auth-side">
        <div className="row">
          {org?.branding.hasLogo
            // eslint-disable-next-line @next/next/no-img-element
            ? <img className="auth-logo" src={`${API_URL}/public/orgs/${org.id}/logo`} alt="" />
            : <Icon name="drop" size={40} />}
        </div>
        <div className="stack-sm">
          <h1>{org ? org.name : 'AguaMata'}</h1>
          <p>{info ? `Te invitaron a unirte como ${info.roleLabel}.` : 'Invitación al equipo del acueducto.'}</p>
        </div>
        <span className="small" style={{ opacity: 0.8 }}>Con tecnología de AguaMata</span>
      </section>
      <main className="auth-main">
        <div className="auth-card">
          {done ? (
            <div className="stack">
              <h1>¡Listo!</h1>
              <p className="muted">Ya haces parte de {org?.name}. Ingresa con tu correo <strong>{info?.email}</strong>.</p>
              <a className="btn" href="/">Iniciar sesión</a>
            </div>
          ) : !info ? (
            <div className="stack">
              <h1>Invitación</h1>
              {error ? <div className="alert alert-danger">{error}</div> : <p className="muted">Verificando…</p>}
            </div>
          ) : (
            <form className="stack" onSubmit={accept}>
              <div className="stack-sm">
                <h1>{info.userExists ? 'Acepta la invitación' : 'Crea tu acceso'}</h1>
                <p className="muted">
                  {info.userExists
                    ? <>Ya tienes una cuenta con <strong>{info.email}</strong>. Escribe tu contraseña para unirte a {org.name}.</>
                    : <>Tu usuario será <strong>{info.email}</strong>.</>}
                </p>
              </div>
              {!info.userExists && (
                <label className="field">Nombre completo<input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} required autoFocus autoComplete="name" /></label>
              )}
              <label className="field">{info.userExists ? 'Tu contraseña' : 'Contraseña (mínimo 8 caracteres)'}
                <input type="password" minLength={info.userExists ? 1 : 8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required autoComplete={info.userExists ? 'current-password' : 'new-password'} autoFocus={info.userExists} />
              </label>
              {!info.userExists && (
                <label className="field">Repite la contraseña<input type="password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} required autoComplete="new-password" /></label>
              )}
              {error && <div className="alert alert-danger">{error}</div>}
              <button className="btn" type="submit" disabled={busy}>{busy ? 'Procesando…' : 'Unirme al acueducto'}</button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
