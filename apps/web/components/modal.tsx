'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Modal accesible sobre <dialog>: foco atrapado, Esc para cerrar, fondo inerte y clic fuera para cerrar.
 * Para formularios, da un id al <form> y usa <button form="id" type="submit"> en el pie.
 */
export function Modal({
  open, onClose, title, children, footer, size = 'md',
}: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; size?: 'md' | 'lg' }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`modal ${size === 'lg' ? 'modal-lg' : ''}`}
      aria-label={title}
      onClose={onClose}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onMouseDown={(e) => { if (e.target === ref.current) onClose(); }}
    >
      {open && (
        <>
          <div className="modal-head">
            <h2>{title}</h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

/** Modal de confirmación con mensaje y, opcionalmente, un motivo obligatorio. */
export function ConfirmModal({
  open, onClose, onConfirm, title, message, confirmLabel = 'Confirmar', danger, reasonLabel, busy, error,
}: {
  open: boolean; onClose: () => void; onConfirm: (reason: string) => void; title: string; message: ReactNode;
  confirmLabel?: string; danger?: boolean; reasonLabel?: string; busy?: boolean; error?: string;
}) {
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
          <button type="submit" form="confirm-form" className={`btn ${danger ? 'btn-danger' : ''}`} disabled={busy}>{busy ? 'Procesando…' : confirmLabel}</button>
        </>
      }
    >
      <form id="confirm-form" className="stack-sm" onSubmit={(e) => { e.preventDefault(); onConfirm(reasonRef.current?.value.trim() ?? ''); }}>
        <div>{message}</div>
        {reasonLabel && (
          <label className="field">{reasonLabel}
            <textarea ref={reasonRef} rows={3} required minLength={5} />
          </label>
        )}
        {error && <div className="alert alert-danger">{error}</div>}
      </form>
    </Modal>
  );
}
