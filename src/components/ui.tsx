import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ShapeKind } from '../dsl/types';
import { shapePath } from '../geom/geom';
import { useStore } from '../store';

export function ShapeIcon({ kind, size = 18 }: { kind: ShapeKind; size?: number }) {
  if (kind === 'text') {
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round">
        <path d="M4 4.5h10M9 4.5v10" />
      </svg>
    );
  }
  if (kind === 'image') {
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round">
        <rect x={2} y={3} width={14} height={12} rx={1.5} />
        <circle cx={6.5} cy={7} r={1.3} />
        <path d="M2.5 13.5l4-4 3 3 2-2 4 4" />
      </svg>
    );
  }
  const box = kind === 'diamond' ? { x: 1.5, y: 2, w: 15, h: 14 } : kind === 'ellipse' ? { x: 1.5, y: 3.5, w: 15, h: 11 } : kind === 'cross' || kind === 'plus' ? { x: 2, y: 2, w: 14, h: 14 } : { x: 1.5, y: 4, w: 15, h: 10 };
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round">
      <path d={shapePath(kind, box, { skew: 0.2, radius: kind === 'round' ? 3.5 : 0 })} />
    </svg>
  );
}

export const SHAPE_NAMES: Record<ShapeKind, string> = {
  rect: '矩形',
  round: '角丸矩形',
  ellipse: '楕円',
  diamond: 'ひし形',
  trap: '台形',
  para: '平行四辺形',
  hex: '六角形',
  cross: '⊗（丸に×）',
  plus: '⊕（丸に＋）',
  text: 'テキスト',
  image: '画像',
};

/**
 * Numeric field whose label can be dragged horizontally to scrub the value.
 * Typing applies live; a focus session (like a scrub) is reported via onScrubStart/End
 * so the caller can make it a single undo step.
 */
export function NumField({ label, value, onChange, onScrubStart, onScrubEnd, step = 1, min }: { label: string; value: number | ''; onChange: (v: number) => void; onScrubStart?: () => void; onScrubEnd?: () => void; step?: number; min?: number }) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value === '' ? '' : String(Math.round(Number(value) * 10) / 10));
  }, [value]);
  const parse = (t: string) => {
    const n = Number(t);
    return t.trim() !== '' && Number.isFinite(n) ? (min !== undefined ? Math.max(min, n) : n) : undefined;
  };
  const scrub = (e: React.PointerEvent) => {
    if (value === '') return;
    const startX = e.clientX;
    const start = Number(value);
    onScrubStart?.();
    const move = (ev: PointerEvent) => {
      const d = Math.round((ev.clientX - startX) / 2) * step * (ev.shiftKey ? 10 : 1);
      const v = start + d;
      onChange(min !== undefined ? Math.max(min, v) : v);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onScrubEnd?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="num-field">
      <span onPointerDown={scrub}>{label}</span>
      <input
        value={text}
        placeholder="—"
        onFocus={() => {
          focused.current = true;
          onScrubStart?.();
        }}
        onBlur={() => {
          focused.current = false;
          if (parse(text) === undefined) setText(value === '' ? '' : String(Math.round(Number(value) * 10) / 10));
          onScrubEnd?.();
        }}
        onChange={(e) => {
          setText(e.target.value);
          const n = parse(e.target.value);
          if (n !== undefined) onChange(n);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const n = (Number(text) || 0) + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            setText(String(n));
            onChange(min !== undefined ? Math.max(min, n) : n);
          }
        }}
      />
    </div>
  );
}

/** Text input / textarea that applies every keystroke live; one focus session = one undo step. */
export function LiveText({ value, onChange, multiline, placeholder, rows }: { value: string; onChange: (v: string) => void; multiline?: boolean; placeholder?: string; rows?: number }) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  const props = {
    className: 'field',
    value: text,
    placeholder,
    onFocus: () => {
      focused.current = true;
      useStore.getState().beginGesture();
    },
    onBlur: () => {
      focused.current = false;
      useStore.getState().endGesture();
      setText(value);
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setText(e.target.value);
      if (!(e.nativeEvent as InputEvent).isComposing) onChange(e.target.value);
    },
    onCompositionEnd: (e: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.currentTarget.value),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && !multiline && !e.nativeEvent.isComposing)) (e.target as HTMLElement).blur();
    },
  };
  return multiline ? <textarea rows={rows} {...props} /> : <input {...props} />;
}

export function Seg<T extends string>({ value, options, onChange, small }: { value: T | undefined; options: { v: T; label: ReactNode; tip?: string }[]; onChange: (v: T) => void; small?: boolean }) {
  return (
    <div className={'seg' + (small ? ' small' : '')} style={{ width: '100%', display: 'flex' }}>
      {options.map((o) => (
        <button key={o.v} className={(o.v === value ? 'on ' : '') + (o.tip ? 'tip tip-bottom' : '')} data-tip={o.tip} style={{ flex: 1, justifyContent: 'center' }} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Swatches({ colors, value, onChange, allowNone }: { colors: string[]; value: string | undefined; onChange: (c: string) => void; allowNone?: boolean }) {
  const v = value?.toLowerCase();
  const isCustom = v && v !== 'none' && !colors.includes(v);
  return (
    <div className="swatches">
      {allowNone && <button className={'swatch none' + (v === 'none' ? ' on' : '')} title="なし" onClick={() => onChange('none')} />}
      {colors.map((c) => (
        <button key={c} className={'swatch' + (v === c ? ' on' : '')} style={{ background: c }} title={c} onClick={() => onChange(c)} />
      ))}
      <label className={'swatch custom' + (isCustom ? ' on' : '')} title="カスタム色" style={isCustom ? { background: v } : undefined}>
        <input type="color" value={v && /^#[0-9a-f]{6}$/.test(v) ? v : '#6366f1'} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  );
}
