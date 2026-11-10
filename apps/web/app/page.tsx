'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, API_URL } from '@/lib/api';
import { useHostTenant } from '@/lib/host';
import { brandStyle, Icon } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const host = useHostTenant();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const tenant = host.status === 'tenant' ? host.tenant : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      // En la dirección de un acueducto, el login queda limitado a ESE acueducto.
      const res = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password, ...(tenant ? { organizationId: tenant.id } : {}) }),
      });
      if (res.activeOrganizationId) router.push('/panel');
      else if (res.user.isPlatformAdmin) router.push('/admin');
      else setError('Tu usuario no pertenece a ningún acueducto activo.');
    } catch (err: any) {
      setError(err.status === 401 ? 'Correo o contraseña incorrectos' : err.message ?? 'No se pudo iniciar sesión');
    } finally {
      setBusy(false);
    }
  }

  if (host.status === 'not_found') {
    return (
      <main className="auth-main" style={{ minHeight: '100vh' }}>
        <div className="auth-card card">
          <h1>Dirección no encontrada</h1>
          <p className="muted">No hay ningún acueducto configurado en esta dirección. Verifica el enlace con tu acueducto.</p>
        </div>
      </main>
    );
  }

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
          <p>
            {tenant
              ? `${tenant.municipality}, ${tenant.department}. Ingreso para el personal administrativo del acueducto.`
              : 'Administración integral para acueductos comunitarios y asociaciones de usuarios de Colombia: suscriptores, lecturas, facturación, recaudo y cumplimiento regulatorio.'}
          </p>
        </div>
        <span className="small" style={{ opacity: 0.8 }}>{tenant ? 'Con tecnología de AguaMata' : '© AguaMata'}</span>
      </section>

      <main className="auth-main">
        <form className="auth-card" onSubmit={submit}>
          <div className="stack-sm">
            <h1>Iniciar sesión</h1>
            <p className="muted">{tenant ? `Ingresa a ${tenant.name}` : 'Ingresa a la administración de tu acueducto'}</p>
          </div>
          <label className="field">Correo<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label className="field">Contraseña<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          {error && <div className="alert alert-danger">{error}</div>}
          <button className="btn" type="submit" disabled={busy || host.status === 'loading'}>{busy ? 'Ingresando…' : 'Ingresar'}</button>
          <a className="small" href="/recuperar" style={{ alignSelf: 'center' }}>¿Olvidaste tu contraseña?</a>
          {host.status === 'platform' && (
            <p className="muted small">¿Tu acueducto aún no usa AguaMata? <a href="/registro">Regístralo gratis</a></p>
          )}
        </form>
      </main>
    </div>
  );
}
