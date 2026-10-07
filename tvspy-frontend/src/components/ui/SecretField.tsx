import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { Button } from './Button';
import { Field, TextInput } from './Field';

/**
 * A write-only secret. The server never sends the stored value, only whether one is set. The value is
 * `undefined` (unchanged), a string (replace) or `null` (remove).
 */
export function SecretField({
  label,
  isSet,
  value,
  onChange,
  hint,
  error,
  placeholder,
  autoComplete = 'new-password',
}: {
  label: string;
  isSet: boolean;
  value: string | null | undefined;
  onChange: (value: string | null | undefined) => void;
  hint?: string;
  error?: string;
  placeholder?: string;
  autoComplete?: string;
}) {
  const [reveal, setReveal] = useState(false);
  const editing = typeof value === 'string' || !isSet;

  if (!editing) {
    return (
      <Field label={label} hint={hint} error={error}>
        {(ids) => (
          <div className="flex flex-wrap items-center gap-2">
            <span
              {...ids}
              className="inline-flex h-9 flex-1 items-center rounded-md border border-line bg-surface-2 px-3 text-sm text-ink-2"
            >
              {value === null ? 'Will be removed when you save' : 'Saved (hidden)'}
            </span>
            {value === null ? (
              <Button size="sm" onClick={() => onChange(undefined)}>
                Keep
              </Button>
            ) : (
              <>
                <Button size="sm" onClick={() => onChange('')}>
                  Change
                </Button>
                <Button size="sm" variant="danger" onClick={() => onChange(null)}>
                  Remove
                </Button>
              </>
            )}
          </div>
        )}
      </Field>
    );
  }

  return (
    <Field label={label} hint={hint} error={error}>
      {(ids) => (
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <TextInput
              {...ids}
              type={reveal ? 'text' : 'password'}
              value={value ?? ''}
              placeholder={placeholder ?? (isSet ? 'Enter a new value' : '')}
              autoComplete={autoComplete}
              spellCheck={false}
              onChange={(e) => onChange(e.target.value)}
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-ink-2 hover:text-ink"
              aria-label={reveal ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
            >
              {reveal ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
            </button>
          </div>
          {isSet && (
            <Button size="sm" variant="ghost" onClick={() => onChange(undefined)}>
              Cancel
            </Button>
          )}
        </div>
      )}
    </Field>
  );
}
