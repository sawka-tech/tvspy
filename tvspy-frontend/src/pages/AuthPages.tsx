import { House, Tv } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Button } from '../components/ui/Button';
import { ErrorNotice } from '../components/ui/Feedback';
import { Field, TextInput } from '../components/ui/Field';
import { useLogin } from '../lib/queries';

function AuthFrame({ title, intro, children }: { title: string; intro?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2 text-lg font-semibold text-ink">
          <Tv className="size-6 text-accent" aria-hidden />
          tvspy
        </div>
        <div className="rounded-lg border border-line bg-surface p-6">
          <h1 className="text-base font-semibold text-ink">{title}</h1>
          {intro && <div className="mt-1 text-sm text-ink-2">{intro}</div>}
          {children && <div className="mt-5">{children}</div>}
        </div>
      </div>
    </div>
  );
}

/** Shown outside the trusted networks when a password is set. */
export function LoginPage({ address }: { address: string | null }) {
  const login = useLogin();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ username, password });
  };
  return (
    <AuthFrame
      title="Log in"
      intro={`You are not on your home network${address ? ` (your address is ${address})` : ''}, so tvspy needs its password.`}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="User name">
          {(ids) => (
            <TextInput
              {...ids}
              autoComplete="username"
              autoFocus
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          )}
        </Field>
        <Field label="Password">
          {(ids) => (
            <TextInput
              {...ids}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        {login.error && <ErrorNotice error={login.error} />}
        <Button type="submit" variant="primary" busy={login.isPending} className="w-full">
          Log in
        </Button>
      </form>
    </AuthFrame>
  );
}

/** Shown outside the trusted networks when no password is set. */
export function NotAvailablePage({ address }: { address: string | null }) {
  return (
    <AuthFrame
      title="Only on your home network"
      intro={
        <div className="space-y-3">
          <p>
            tvspy opens without a login from your home network and VPN, and from nowhere else
            {address ? ` (this browser's address is ${address})` : ''}.
          </p>
          <p className="flex items-start gap-2">
            <House className="mt-0.5 size-4 shrink-0 text-ink-2" aria-hidden />
            <span>
              Open it from home or through your VPN. To use it from other networks too, set a password at home
              under Settings → Access.
            </span>
          </p>
        </div>
      }
    />
  );
}
