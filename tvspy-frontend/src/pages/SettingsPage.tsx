import type { Settings, SettingsPatch, TestResult } from '@tvspy/shared';
import { Plug, Save, Send } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Button } from '../components/ui/Button';
import { Card, PageHeader } from '../components/ui/Card';
import { ErrorNotice, errorMessage, Skeleton } from '../components/ui/Feedback';
import { Field, Switch, TextArea, TextInput } from '../components/ui/Field';
import { SecretField } from '../components/ui/SecretField';
import { StatusChip } from '../components/ui/StatusChip';
import { ApiError } from '../lib/api';
import { formatBytes, formatDateTime } from '../lib/format';
import {
  useAbout,
  useChangePassword,
  useSaveSettings,
  useSettings,
  useTestTelegram,
  useTestTvh,
} from '../lib/queries';
import { useServer } from '../lib/server';

type Secret = string | null | undefined;

/** Server field errors ("tvh.url") for one section. */
const fieldError = (err: unknown, path: string) => (err instanceof ApiError ? err.fields[path] : undefined);

function SaveRow({
  dirty,
  busy,
  saved,
  error,
  extra,
}: {
  dirty: boolean;
  busy: boolean;
  saved: boolean;
  error: unknown;
  extra?: ReactNode;
}) {
  const generic = error && !(error instanceof ApiError && Object.keys(error.fields).length > 0);
  return (
    <div className="mt-4 space-y-3">
      {generic ? <ErrorNotice error={error} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={!dirty}
          busy={busy}
          icon={<Save className="size-4" aria-hidden />}
        >
          Save
        </Button>
        {extra}
        {saved && !dirty && <span className="text-sm text-good-ink">Saved</span>}
      </div>
    </div>
  );
}

function TestOutcome({ result, error }: { result?: TestResult; error: unknown }) {
  if (error) return <StatusChip tone="critical">{errorMessage(error)}</StatusChip>;
  if (!result) return null;
  return result.ok ? (
    <StatusChip tone="good">{result.detail}</StatusChip>
  ) : (
    <span className="inline-flex items-start gap-1.5 text-sm text-ink">
      <StatusChip tone="critical">Failed</StatusChip>
      <span>{result.message}</span>
    </span>
  );
}

function useSection(onSaved?: (s: Settings) => void) {
  const save = useSaveSettings();
  const [saved, setSaved] = useState(false);
  const submit = (patch: SettingsPatch) => {
    setSaved(false);
    save.mutate(patch, {
      onSuccess: (s) => {
        setSaved(true);
        onSaved?.(s);
      },
    });
  };
  return { save, saved, submit };
}

function TvhSection({ settings }: { settings: Settings }) {
  const [url, setUrl] = useState(settings.tvh.url);
  const [username, setUsername] = useState(settings.tvh.username);
  const [password, setPassword] = useState<Secret>(undefined);
  const { save, saved, submit } = useSection(() => setPassword(undefined));
  const test = useTestTvh();
  const dirty = url !== settings.tvh.url || username !== settings.tvh.username || password !== undefined;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit({
      tvh: { url: url.trim(), username: username.trim(), ...(password !== undefined ? { password } : {}) },
    });
  };
  return (
    <Card
      title="TVHeadend"
      description="tvspy reads TVHeadend's status pages, so the account needs admin rights."
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Field
          label="Address"
          hint="For example http://192.168.1.10:9981"
          error={fieldError(save.error, 'tvh.url')}
        >
          {(ids) => (
            <TextInput
              {...ids}
              type="url"
              inputMode="url"
              placeholder="http://host:9981"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          )}
        </Field>
        <Field label="User name" error={fieldError(save.error, 'tvh.username')}>
          {(ids) => (
            <TextInput
              {...ids}
              autoComplete="off"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          )}
        </Field>
        <SecretField
          label="Password"
          isSet={settings.tvh.passwordSet}
          value={password}
          onChange={setPassword}
          error={fieldError(save.error, 'tvh.password')}
        />
        <SaveRow
          dirty={dirty}
          busy={save.isPending}
          saved={saved}
          error={save.error}
          extra={
            <>
              <Button
                busy={test.isPending}
                icon={<Plug className="size-4" aria-hidden />}
                onClick={() =>
                  test.mutate({
                    url: url.trim() || undefined,
                    username: username.trim() || undefined,
                    ...(typeof password === 'string' ? { password } : {}),
                  })
                }
              >
                Test connection
              </Button>
              <TestOutcome result={test.data} error={test.error} />
            </>
          }
        />
      </form>
    </Card>
  );
}

function TelegramSection({ settings }: { settings: Settings }) {
  const [enabled, setEnabled] = useState(settings.telegram.enabled);
  const [chatId, setChatId] = useState(settings.telegram.chatId);
  const [botToken, setBotToken] = useState<Secret>(undefined);
  const { save, saved, submit } = useSection(() => setBotToken(undefined));
  const test = useTestTelegram();
  const dirty =
    enabled !== settings.telegram.enabled || chatId !== settings.telegram.chatId || botToken !== undefined;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit({ telegram: { enabled, chatId: chatId.trim(), ...(botToken !== undefined ? { botToken } : {}) } });
  };
  return (
    <Card
      title="Telegram"
      description="Alerts go to one chat through your own bot (create it with @BotFather)."
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Switch checked={enabled} onChange={setEnabled} label="Send notifications" />
        <SecretField
          label="Bot token"
          isSet={settings.telegram.botTokenSet}
          value={botToken}
          onChange={setBotToken}
          hint="From @BotFather, looks like 123456:ABC-…"
          error={fieldError(save.error, 'telegram.botToken')}
        />
        <Field
          label="Chat ID"
          hint="Your user ID or a group ID; send the bot a message first"
          error={fieldError(save.error, 'telegram.chatId')}
        >
          {(ids) => (
            <TextInput
              {...ids}
              inputMode="numeric"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
            />
          )}
        </Field>
        <SaveRow
          dirty={dirty}
          busy={save.isPending}
          saved={saved}
          error={save.error}
          extra={
            <>
              <Button
                busy={test.isPending}
                icon={<Send className="size-4" aria-hidden />}
                onClick={() =>
                  test.mutate({
                    ...(typeof botToken === 'string' && botToken ? { botToken } : {}),
                    ...(chatId.trim() ? { chatId: chatId.trim() } : {}),
                  })
                }
              >
                Send test message
              </Button>
              <TestOutcome result={test.data} error={test.error} />
            </>
          }
        />
      </form>
    </Card>
  );
}

function RulesSection({ settings }: { settings: Settings }) {
  const [r, setR] = useState(settings.rules);
  const { save, saved, submit } = useSection();
  const dirty = JSON.stringify(r) !== JSON.stringify(settings.rules);
  const set = (k: keyof Omit<Settings['rules'], 'longWatch'>) => (v: boolean) => setR({ ...r, [k]: v });
  return (
    <Card title="Notifications" description="Which events are sent to Telegram. Texts are fixed.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit({ rules: r });
        }}
      >
        <div className="divide-y divide-line">
          <Switch
            checked={r.tvhDown}
            onChange={set('tvhDown')}
            label="TVHeadend unreachable"
            description="After 90 seconds without an answer, and when it is back."
          />
          <Switch
            checked={r.muxStale}
            onChange={set('muxStale')}
            label="No reception"
            description="A multiplex could not be received for 27 hours, not even by the overnight guide update."
          />
          <Switch checked={r.playbackStart} onChange={set('playbackStart')} label="Someone starts watching" />
          <Switch checked={r.playbackStop} onChange={set('playbackStop')} label="Someone stops watching" />
          <Switch checked={r.recordingStart} onChange={set('recordingStart')} label="A recording starts" />
          <Switch
            checked={r.recordingStop}
            onChange={set('recordingStop')}
            label="A recording ends or fails"
          />
          <Switch
            checked={r.longWatch.enabled}
            onChange={(v) => setR({ ...r, longWatch: { ...r.longWatch, enabled: v } })}
            label="Long viewing"
            description="One message when a visit (including channel changes) gets longer than:"
          />
          <div className="pb-2">
            <Field
              label="Long viewing after (minutes)"
              error={fieldError(save.error, 'rules.longWatch.limitMinutes')}
            >
              {(ids) => (
                <TextInput
                  {...ids}
                  type="number"
                  min={1}
                  max={1440}
                  value={r.longWatch.limitMinutes}
                  disabled={!r.longWatch.enabled}
                  onChange={(e) =>
                    setR({ ...r, longWatch: { ...r.longWatch, limitMinutes: Number(e.target.value) } })
                  }
                  className="max-w-32"
                />
              )}
            </Field>
          </div>
        </div>
        <SaveRow dirty={dirty} busy={save.isPending} saved={saved} error={save.error} />
      </form>
    </Card>
  );
}

const rows = (s: string) => Math.min(6, Math.max(2, s.split('\n').length + 1));

const lines = (s: string) =>
  s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

function MonitoringSection({ settings }: { settings: Settings }) {
  const m = settings.monitoring;
  const [tuners, setTuners] = useState(String(m.tunersExpected));
  const [good, setGood] = useState(String(m.snrGoodDb));
  const [critical, setCritical] = useState(String(m.snrCriticalDb));
  const [minSec, setMinSec] = useState(String(m.minSessionSec));
  const [lan, setLan] = useState(m.lanCidrs.join('\n'));
  const [proxy, setProxy] = useState(m.proxyCidrs.join('\n'));
  const [trusted, setTrusted] = useState(m.trustedIps.join('\n'));
  const { save, saved, submit } = useSection();
  const next = {
    tunersExpected: Number(tuners),
    snrGoodDb: Number(good),
    snrCriticalDb: Number(critical),
    minSessionSec: Number(minSec),
    lanCidrs: lines(lan),
    proxyCidrs: lines(proxy),
    trustedIps: lines(trusted),
  };
  const dirty = JSON.stringify(next) !== JSON.stringify(m);
  const err = (k: string) => fieldError(save.error, `monitoring.${k}`);
  return (
    <Card title="Monitoring">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit({ monitoring: next });
        }}
        className="space-y-4"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tuners" hint="0 = as many as TVHeadend reports" error={err('tunersExpected')}>
            {(ids) => (
              <TextInput
                {...ids}
                type="number"
                min={0}
                max={32}
                value={tuners}
                onChange={(e) => setTuners(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Shortest session to count (seconds)"
            hint="Shorter ones are channel flips"
            error={err('minSessionSec')}
          >
            {(ids) => (
              <TextInput
                {...ids}
                type="number"
                min={0}
                max={3600}
                value={minSec}
                onChange={(e) => setMinSec(e.target.value)}
              />
            )}
          </Field>
          <Field label="Good SNR from (dB)" error={err('snrGoodDb')}>
            {(ids) => (
              <TextInput
                {...ids}
                type="number"
                step={0.5}
                min={0}
                max={60}
                value={good}
                onChange={(e) => setGood(e.target.value)}
              />
            )}
          </Field>
          <Field label="Critical SNR below (dB)" error={err('snrCriticalDb')}>
            {(ids) => (
              <TextInput
                {...ids}
                type="number"
                step={0.5}
                min={0}
                max={60}
                value={critical}
                onChange={(e) => setCritical(e.target.value)}
              />
            )}
          </Field>
        </div>
        <Field
          label="Home network ranges"
          hint="One address or range per line; shown as “Home network”"
          error={err('lanCidrs')}
        >
          {(ids) => (
            <TextArea {...ids} rows={rows(lan)} value={lan} onChange={(e) => setLan(e.target.value)} />
          )}
        </Field>
        <Field
          label="HTTPS proxy addresses"
          hint="Clients arriving from here came through the proxy; their real address is hidden"
          error={err('proxyCidrs')}
        >
          {(ids) => (
            <TextArea {...ids} rows={rows(proxy)} value={proxy} onChange={(e) => setProxy(e.target.value)} />
          )}
        </Field>
        <Field
          label="Trusted addresses"
          hint="Known viewer addresses (kept from the old tvspy)"
          error={err('trustedIps')}
        >
          {(ids) => (
            <TextArea
              {...ids}
              rows={rows(trusted)}
              value={trusted}
              onChange={(e) => setTrusted(e.target.value)}
            />
          )}
        </Field>
        <SaveRow dirty={dirty} busy={save.isPending} saved={saved} error={save.error} />
      </form>
    </Card>
  );
}

function AccountSection() {
  const change = useChangePassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const mismatch = repeat !== '' && repeat !== next;
  return (
    <Card title="Password" description="Changing it logs out every other browser.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (mismatch) return;
          change.mutate(
            { currentPassword: current, newPassword: next },
            {
              onSuccess: () => {
                setCurrent('');
                setNext('');
                setRepeat('');
              },
            },
          );
        }}
        className="max-w-sm space-y-4"
      >
        <Field label="Current password" error={fieldError(change.error, 'currentPassword')}>
          {(ids) => (
            <TextInput
              {...ids}
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="New password"
          hint="At least 8 characters"
          error={fieldError(change.error, 'newPassword')}
        >
          {(ids) => (
            <TextInput
              {...ids}
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          )}
        </Field>
        <Field label="Repeat new password" error={mismatch ? 'The passwords differ' : undefined}>
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
        {change.error && !(change.error instanceof ApiError && Object.keys(change.error.fields).length) ? (
          <ErrorNotice error={change.error} />
        ) : null}
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" busy={change.isPending} disabled={mismatch || !next}>
            Change password
          </Button>
          {change.isSuccess && <span className="text-sm text-good-ink">Password changed</span>}
        </div>
      </form>
    </Card>
  );
}

function AboutSection() {
  const about = useAbout();
  const { tz } = useServer();
  if (about.error) return <ErrorNotice error={about.error} onRetry={() => void about.refetch()} />;
  const a = about.data;
  const row = (label: string, value: ReactNode) => (
    <div className="grid grid-cols-[10rem_minmax(0,1fr)] gap-2 py-1.5 text-sm">
      <dt className="text-ink-2">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
  return (
    <Card title="About">
      {!a ? (
        <Skeleton className="h-24" />
      ) : (
        <dl className="divide-y divide-line">
          {row('Version', `${a.version}${a.commit ? ` (${a.commit})` : ''}`)}
          {row(
            'Database',
            `${a.database.sessions.toLocaleString('en-GB')} sessions, ${formatBytes(a.database.sizeBytes)}, schema v${a.schema}`,
          )}
          {row('History since', a.database.firstSession ? formatDateTime(a.database.firstSession, tz) : '–')}
          {row(
            'Old tvspy data',
            a.legacyImport
              ? `${a.legacyImport.sessions.toLocaleString('en-GB')} sessions imported ${formatDateTime(a.legacyImport.at, tz)}`
              : 'None',
          )}
        </dl>
      )}
    </Card>
  );
}

export function SettingsPage() {
  const settings = useSettings();
  return (
    <>
      <PageHeader title="Settings" />
      {settings.error ? (
        <ErrorNotice error={settings.error} onRetry={() => void settings.refetch()} />
      ) : !settings.data ? (
        <div className="space-y-4">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <div className="space-y-5">
            <TvhSection settings={settings.data} />
            <TelegramSection settings={settings.data} />
            <RulesSection settings={settings.data} />
          </div>
          <div className="space-y-5">
            <MonitoringSection settings={settings.data} />
            <AccountSection />
            <AboutSection />
          </div>
        </div>
      )}
    </>
  );
}
