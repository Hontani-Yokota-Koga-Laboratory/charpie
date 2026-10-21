/**
 * In-app dialogs (instead of the browser's prompt / confirm): `openDialog` shows any content in a
 * modal and resolves with what it reports; `askText` and `askConfirm` cover the common cases.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { X } from 'lucide-react';

interface Open {
  id: number;
  render: (done: (v: unknown) => void) => ReactNode;
  resolve: (v: unknown) => void;
}

const useDialogs = create<{ stack: Open[] }>(() => ({ stack: [] }));
let nextId = 1;

/** Show `render` in a modal; resolves with the value passed to `done` (null when dismissed). */
export function openDialog<T>(render: (done: (v: T | null) => void) => ReactNode): Promise<T | null> {
  return new Promise((resolve) => {
    const id = nextId++;
    const close = (v: unknown) => {
      useDialogs.setState((s) => ({ stack: s.stack.filter((d) => d.id !== id) }));
      resolve(v as T | null);
    };
    useDialogs.setState((s) => ({ stack: [...s.stack, { id, render: (done) => render(done as (v: T | null) => void), resolve: close }] }));
  });
}

export function DialogHost() {
  const stack = useDialogs((s) => s.stack);
  if (!stack.length) return null;
  return createPortal(
    <>
      {stack.map((d) => (
        <div key={d.id} className="dlg-backdrop" onPointerDown={(e) => e.target === e.currentTarget && d.resolve(null)}>
          {d.render(d.resolve)}
        </div>
      ))}
    </>,
    document.body,
  );
}

/** The dialog frame: title, body, buttons. Esc dismisses; the form submits on Enter. */
export function Modal({ title, icon, children, footer, onClose, onSubmit, width = 440 }: { title: ReactNode; icon?: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; onSubmit?: () => void; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <form
      className="float dlg"
      style={{ width }}
      role="dialog"
      onKeyDown={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.();
      }}
    >
      <div className="dlg-head">
        {icon && <span className="dlg-icon">{icon}</span>}
        <div className="dlg-title">{title}</div>
        <button type="button" className="icon-btn" aria-label="閉じる" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="dlg-body">{children}</div>
      {footer && <div className="dlg-foot">{footer}</div>}
    </form>
  );
}

export function DialogButtons({ ok = 'OK', cancel = 'キャンセル', onCancel, disabled, danger }: { ok?: string; cancel?: string; onCancel: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <>
      <button type="button" className="btn" onClick={onCancel}>
        {cancel}
      </button>
      <button type="submit" className={'btn ' + (danger ? 'danger' : 'primary')} disabled={disabled}>
        {ok}
      </button>
    </>
  );
}

/** A text field that is focused (and selected) when the dialog opens. */
export function AutoField({ value, onChange, placeholder, suffix, mono }: { value: string; onChange: (v: string) => void; placeholder?: string; suffix?: string; mono?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div className="dlg-field">
      <input ref={ref} className={'field' + (mono ? ' mono' : '')} value={value} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      {suffix && <span className="dlg-suffix">{suffix}</span>}
    </div>
  );
}

export function askText(o: { title: string; message?: ReactNode; label?: string; value?: string; placeholder?: string; ok?: string; suffix?: string; validate?: (v: string) => string | null }): Promise<string | null> {
  return openDialog<string>((done) => <TextDialog o={o} done={done} />);
}

function TextDialog({ o, done }: { o: Parameters<typeof askText>[0]; done: (v: string | null) => void }) {
  const [v, setV] = useState(o.value ?? '');
  const err = v.trim() ? (o.validate?.(v.trim()) ?? null) : null;
  return (
    <Modal title={o.title} onClose={() => done(null)} onSubmit={() => v.trim() && !err && done(v.trim())} footer={<DialogButtons ok={o.ok} onCancel={() => done(null)} disabled={!v.trim() || !!err} />}>
      {o.message && <div className="dlg-msg">{o.message}</div>}
      {o.label && <label className="dlg-label">{o.label}</label>}
      <AutoField value={v} onChange={setV} placeholder={o.placeholder} suffix={o.suffix} />
      {err && <div className="dlg-err">{err}</div>}
    </Modal>
  );
}

export function askConfirm(o: { title: string; message?: ReactNode; ok?: string; cancel?: string; danger?: boolean }): Promise<boolean> {
  return openDialog<boolean>((done) => (
    <Modal title={o.title} onClose={() => done(false)} onSubmit={() => done(true)} footer={<ConfirmButtons o={o} done={done} />} width={420}>
      {o.message && <div className="dlg-msg">{o.message}</div>}
    </Modal>
  )).then((v) => !!v);
}

function ConfirmButtons({ o, done }: { o: Parameters<typeof askConfirm>[0]; done: (v: boolean | null) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <>
      <button type="button" className="btn" onClick={() => done(false)}>
        {o.cancel ?? 'キャンセル'}
      </button>
      <button ref={ref} type="submit" className={'btn ' + (o.danger ? 'danger' : 'primary')}>
        {o.ok ?? 'OK'}
      </button>
    </>
  );
}
