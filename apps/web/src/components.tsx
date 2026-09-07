import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Meal } from '@bloom/contracts';

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return <label className="field"><span className="field__label">{label}</span>{children}{error ? <span className="field__error">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}</label>;
}

export function SelectField(props: React.SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return <span className="select-wrap"><select {...props}>{props.children}</select><ChevronDown size={17} aria-hidden="true" /></span>;
}

const toIsoDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const parseIsoDate = (value: string) => value ? new Date(`${value}T00:00:00`) : new Date();

export function DatePicker({ label, value, onChange, min, allowClear = false }: { label: string; value: string; onChange: (value: string) => void; min?: string; allowClear?: boolean }) {
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => parseIsoDate(value));
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  useEffect(() => { if (value) setVisibleMonth(parseIsoDate(value)); }, [value]);
  const first = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1);
  const start = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1 - first.getDay());
  const days = Array.from({ length: 42 }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); return date; });
  const displayValue = value ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }).format(parseIsoDate(value)) : 'Pick a date';
  return <div className="field date-picker" ref={root} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}>
    <span className="field__label">{label}</span>
    <button type="button" className="date-picker__trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      <span className={value ? '' : 'placeholder'}>{displayValue}</span><CalendarDays size={18} aria-hidden="true" />
    </button>
    {open && <div className="date-picker__popover" role="dialog" aria-label={`Choose ${label.toLowerCase()}`}>
      <div className="date-picker__header"><strong>{new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(visibleMonth)}</strong><span><button type="button" onClick={() => setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1))} aria-label="Previous month"><ChevronLeft size={17} /></button><button type="button" onClick={() => setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1))} aria-label="Next month"><ChevronRight size={17} /></button></span></div>
      <div className="date-picker__weekdays" aria-hidden="true">{['S','M','T','W','T','F','S'].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div>
      <div className="date-picker__days">{days.map((date) => { const day = toIsoDate(date); const disabled = Boolean(min && day < min); return <button type="button" key={day} disabled={disabled} className={`${date.getMonth() !== visibleMonth.getMonth() ? 'outside ' : ''}${day === value ? 'selected ' : ''}${day === toIsoDate(new Date()) ? 'today' : ''}`} aria-label={new Intl.DateTimeFormat('en-IN', { dateStyle: 'full' }).format(date)} onClick={() => { onChange(day); setOpen(false); }}>{date.getDate()}</button>; })}</div>
      <div className="date-picker__footer">{allowClear ? <button type="button" onClick={() => { onChange(''); setOpen(false); }}>Clear</button> : <span />}<button type="button" onClick={() => { const day = toIsoDate(new Date()); if (!min || day >= min) onChange(day); setOpen(false); }}>Today</button></div>
    </div>}
  </div>;
}

export function MealCombobox({ meals, selected, onChange, label = 'Choose meals' }: { meals: Meal[]; selected: string[]; onChange: (ids: string[]) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close);
  }, []);
  const filtered = meals.filter((meal) => meal.name.toLowerCase().includes(query.toLowerCase()));
  return <div className="combobox" ref={root}>
    <button type="button" className="combobox__trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span>{selected.length ? `${selected.length} meal${selected.length === 1 ? '' : 's'} selected` : label}</span><ChevronDown size={18} />
    </button>
    {selected.length > 0 && <div className="selection-chips">{selected.map((id) => {
      const meal = meals.find((item) => item.id === id); if (!meal) return null;
      return <button type="button" key={id} onClick={() => onChange(selected.filter((value) => value !== id))}>{meal.name}<X size={13} aria-label={`Remove ${meal.name}`} /></button>;
    })}</div>}
    {open && <div className="combobox__menu">
      <label className="combobox__search"><Search size={16} /><span className="sr-only">Search meals</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search meal library" /></label>
      <div role="listbox" aria-multiselectable="true">
        {filtered.map((meal) => { const active = selected.includes(meal.id); return <button type="button" role="option" aria-selected={active} key={meal.id} onClick={() => onChange(active ? selected.filter((id) => id !== meal.id) : [...selected, meal.id])}><span>{meal.name}</span>{active && <Check size={16} />}</button>; })}
        {!filtered.length && <p className="combobox__empty">No matching meals.</p>}
      </div>
    </div>}
  </div>;
}

export function Notice({ tone = 'neutral', children }: { tone?: 'neutral' | 'success' | 'error'; children: ReactNode }) {
  return <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function ConfirmDialog({ open, title, description, confirmLabel, busy = false, tone = 'danger', onConfirm, onCancel }: { open: boolean; title: string; description: string; confirmLabel: string; busy?: boolean; tone?: 'danger' | 'primary'; onConfirm: () => void; onCancel: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) cancelRef.current?.focus(); }, [open]);
  if (!open) return null;
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) onCancel(); }}>
    <section className="dialog confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description">
      <p className="eyebrow">Please confirm</p><h2 id="confirm-title">{title}</h2><p id="confirm-description">{description}</p>
      <div className="confirm-dialog__actions"><button ref={cancelRef} type="button" className="button button--quiet" onClick={onCancel} disabled={busy}>Keep it</button><button type="button" className={`button ${tone === 'danger' ? 'button--danger' : 'button--primary'}`} onClick={onConfirm} disabled={busy}>{busy ? 'Working…' : confirmLabel}</button></div>
    </section>
  </div>;
}

export function Spinner({ label }: { label: string }) { return <div className="loading-state"><i aria-hidden="true" /><span>{label}</span></div>; }
