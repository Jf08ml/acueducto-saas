'use client';

import { useEffect, useState } from 'react';
import { api, API_URL } from '@/lib/api';
import { useHostTenant } from '@/lib/host';
import { brandStyle, errorText, Icon } from '@/components/ui';

/**
 * Recuperar la contraseña. Sin token: pide el correo y envía el enlace. Con token (?token=): crea la contraseña nueva.
 * Desde la dirección de un acueducto, el enlace del correo vuelve a esa misma dirección.
 */
export default function RecuperarPage() {
  const host = useHostTenant();
  const tenant = host.status === 'tenant' ? host.tenant : null;
  const [token, setTok] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setTok(new URLSearchParams(window.location.search).get('token'));
    setReady(true);
  }, []);

  return (
    <div className="auth" style={brandStyle(tenant?.branding.primaryColor)}>
      <section className="auth-side">
        <div className="row">
          {tenant?.branding.hasLogo
            // eslint-disable-next-line @next/next/no-img-element
            ? <img className="auth-logo" src={`${API_URL}/public/orgs/${tenant.id}/logo`} alt="" />
            : <Icon name="drop" size={40} />}
        </div>
        <div className="stack-sm">
          <h1>{tenant ? tenant.name : 'AguaMata'}</h1>
          <p>Recupera el acceso a tu cuenta.</p>
        </div>
        <span className="small" style={{ opacity: 0.8 }}>{tenant ? 'Con tecnología de AguaMata' : '© AguaMata'}</span>
      </section>
      <main className="auth-main">
        <div className="auth-card">
          {!ready || host.status === 'loading' ? <p className="muted">Cargando…</p>
            : token ? <ResetForm token={token} />
            : <RequestForm organizationId={tenant?.id} />}
        </div>
      </main>
    </div>
  );
}

function RequestForm({ organizationId }: { organizationId?: string }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/auth/password-reset', { method: 'POST', body: JSON.stringify({ email, ...(organizationId ? { organizationId } : {}) }) });
      setSent(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="stack">
        <h1>Revisa tu correo</h1>
        <p className="muted">
          Si <strong>{email}</strong> tiene una cuenta, te enviamos un enlace para crear una contraseña nueva. Vence en 60 minutos.
        </p>
        <p className="muted small">¿No llega? Revisa la carpeta de spam o pide ayuda al administrador de tu acueducto.</p>
        <a className="btn btn-secondary" href="/">Volver a iniciar sesión</a>
      </div>
    );
  }
  return (
    <form className="stack" onSubmit={submit}>
      <div className="stack-sm">
        <h1>¿Olvidaste tu contraseña?</h1>
        <p className="muted">Escribe el correo con el que ingresas y te enviaremos un enlace para crear una nueva.</p>
      </div>
      <label className="field">Correo<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
      {error && <div className="alert alert-danger">{error}</div>}
      <button className="btn" type="submit" disabled={busy}>{busy ? 'Enviando…' : 'Enviar enlace'}</button>
      <a className="small" href="/" style={{ alignSelf: 'center' }}>Volver a iniciar sesión</a>
    </form>
  );
}

function ResetForm({ token }: { token: string }) {
  const [info, setInfo] = useState<{ email: string } | null>(null);
  const [f, setF] = useState({ password: '', confirm: '' });
  const [error, setError] = useState('');
  const [fatal, setFatal] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api(`/auth/password-reset/${encodeURIComponent(token)}`).then(setInfo).catch((e) => setFatal(errorText(e)));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (f.password !== f.confirm) { setError('Las contraseñas no coinciden'); return; }
    setBusy(true);
    setError('');
    try {
      await api(`/auth/password-reset/${encodeURIComponent(token)}`, { method: 'POST', body: JSON.stringify({ password: f.password }) });
      window.history.replaceState(null, '', '/recuperar');
      setDone(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (fatal) {
    return (
      <div className="stack">
        <h1>Enlace no válido</h1>
        <div className="alert alert-danger">{fatal}</div>
        <a className="btn" href="/recuperar">Pedir un enlace nuevo</a>
      </div>
    );
  }
  if (done) {
    return (
      <div className="stack">
        <h1>Contraseña actualizada</h1>
        <p className="muted">Por seguridad cerramos todas tus sesiones abiertas. Ingresa con tu contraseña nueva.</p>
        <a className="btn" href="/">Iniciar sesión</a>
      </div>
    );
  }
  if (!info) return <p className="muted">Verificando el enlace…</p>;
  return (
    <form className="stack" onSubmit={submit}>
      <div className="stack-sm">
        <h1>Crea tu contraseña nueva</h1>
        <p className="muted">Para la cuenta <strong>{info.email}</strong>.</p>
      </div>
      <label className="field">Contraseña nueva (mínimo 8)<input type="password" minLength={8} autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required autoFocus /></label>
      <label className="field">Repítela<input type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required /></label>
      {error && <div className="alert alert-danger">{error}</div>}
      <button className="btn" type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Guardar contraseña'}</button>
    </form>
  );
}
