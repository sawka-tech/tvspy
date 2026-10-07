import { KeyRound, Tv } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Button } from '../components/ui/Button';
import { ErrorNotice } from '../components/ui/Feedback';
import { Field, TextInput } from '../components/ui/Field';
import { ApiError } from '../lib/api';
import { useLogin, useSetup } from '../lib/queries';

function AuthFrame({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
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
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </div>
  );
}

const fieldError = (err: unknown, field: string) => (err instanceof ApiError ? err.fields[field] : undefined);

export function LoginPage() {
  const login = useLogin();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ username, password });
  };
  return (
    <AuthFrame title="Log in">
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
      <p className="mt-4 text-xs text-ink-2">
        Forgot the password? Reset it on the server:{' '}
        <code className="text-ink">docker exec -it tvspy node dist/cli.js set-password</code>
      </p>
    </AuthFrame>
  );
}

export function SetupPage() {
  const setup = useSetup();
  const [setupCode, setSetupCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const mismatch = repeat !== '' && repeat !== password;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setup.mutate({ setupCode, username, password });
  };
  return (
    <AuthFrame
      title="Create the admin account"
      intro={
        <>
          tvspy shows viewers' addresses and your TVHeadend settings, so it needs a login. To prove this is
          your server, enter the setup code from the container log (
          <code className="text-ink">docker logs tvspy</code>).
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Setup code" hint="Looks like ABCD-EFGH" error={fieldError(setup.error, 'setupCode')}>
          {(ids) => (
            <TextInput
              {...ids}
              autoComplete="one-time-code"
              autoFocus
              required
              spellCheck={false}
              value={setupCode}
              onChange={(e) => setSetupCode(e.target.value)}
              className="font-mono uppercase"
            />
          )}
        </Field>
        <Field label="User name" error={fieldError(setup.error, 'username')}>
          {(ids) => (
            <TextInput
              {...ids}
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          )}
        </Field>
        <Field label="Password" hint="At least 8 characters" error={fieldError(setup.error, 'password')}>
          {(ids) => (
            <TextInput
              {...ids}
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <Field label="Repeat password" error={mismatch ? 'The passwords differ' : undefined}>
          {(ids) => (
            <TextInput
              {...ids}
              type="password"
              autoComplete="new-password"
              required
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            />
          )}
        </Field>
        {setup.error && !(setup.error instanceof ApiError && Object.keys(setup.error.fields).length) && (
          <ErrorNotice error={setup.error} />
        )}
        <Button
          type="submit"
          variant="primary"
          busy={setup.isPending}
          disabled={mismatch}
          className="w-full"
          icon={<KeyRound className="size-4" aria-hidden />}
        >
          Create account
        </Button>
      </form>
    </AuthFrame>
  );
}
