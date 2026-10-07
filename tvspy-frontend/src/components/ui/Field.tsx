import {
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from 'react';

const control =
  'rounded-md border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-muted disabled:opacity-60 aria-invalid:border-critical';
/** Full width unless the caller gives a width (w-…, max-w-… is not a width). */
const width = (className: string) => (/(^|\s)w-/.test(className) ? '' : 'w-full');

/** Label, hint and error around one control; wires the ids for screen readers. */
export function Field({
  label,
  hint,
  error,
  children,
  className = '',
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-ink">
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {error && (
        <p id={errorId} className="mt-1 text-sm text-critical-ink">
          {error}
        </p>
      )}
      {hint && (
        <p id={hintId} className="mt-1 text-xs text-ink-2">
          {hint}
        </p>
      )}
    </div>
  );
}

export function TextInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${control} ${width(className)} h-9 ${className}`} {...props} />;
}

export function TextArea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${control} ${width(className)} py-2 font-mono ${className}`} {...props} />;
}

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${control} ${width(className)} h-9 pr-8 ${className}`} {...props}>
      {children}
    </select>
  );
}

/** An on/off switch: a checkbox with role="switch", labelled by its visible text. */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
        </label>
        {description && <p className="text-sm text-ink-2">{description}</p>}
      </div>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input
          id={id}
          type="checkbox"
          role="switch"
          aria-checked={checked}
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="peer h-5 w-9 cursor-pointer appearance-none rounded-full border border-line-strong bg-surface-2 transition-colors checked:border-accent checked:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute top-0.5 left-0.5 size-4 rounded-full bg-surface shadow-sm transition-transform peer-checked:translate-x-4"
        />
      </span>
    </div>
  );
}
