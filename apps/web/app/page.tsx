'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const res = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      setToken(res.accessToken);
      router.push(res.activeOrganizationId ? '/panel' : res.user.isPlatformAdmin ? '/admin' : '/');
    } catch (err: any) {
      setError(err.message ?? 'No se pudo iniciar sesión');
    }
  }

  return (
    <main className="container">
      <form className="card narrow stack" onSubmit={submit}>
        <h1 style={{ margin: 0 }}>AguaMata</h1>
        <p className="muted" style={{ margin: 0 }}>Ingresa a la administración de tu acueducto</p>
        <label>Correo<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Contraseña<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <p className="error">{error}</p>}
        <button type="submit">Ingresar</button>
        <p className="muted" style={{ margin: 0 }}>
          ¿Tu acueducto aún no está registrado? <a href="/registro">Regístralo aquí</a>
        </p>
      </form>
    </main>
  );
}
