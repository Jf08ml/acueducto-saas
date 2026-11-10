'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { logout } from '@/lib/api';
import { usePlatformOnly } from '@/lib/host';
import { Icon } from './ui';

const NAV = [
  { href: '/admin', label: 'Organizaciones', icon: 'building' },
  { href: '/admin/cobros', label: 'Cobros', icon: 'cash' },
];

/** Marco del panel Superadmin. Solo existe en el dominio de la plataforma. */
export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const platformOk = usePlatformOnly();
  if (!platformOk) return null;
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Icon name="drop" /></span><span className="brand-name">AguaMata<br /><span className="small muted">Superadmin</span></span></div>
        {NAV.map((n) => (
          <a key={n.href} className="nav-link" href={n.href} aria-current={pathname === n.href ? 'page' : undefined}><Icon name={n.icon} /> {n.label}</a>
        ))}
        <div className="sidebar-foot">
          <button className="nav-link" style={{ border: 0, background: 'none', cursor: 'pointer', font: 'inherit' }} onClick={() => logout()}>
            <Icon name="logout" /> Salir
          </button>
        </div>
      </aside>
      <div className="main"><div className="content">{children}</div></div>
    </div>
  );
}
