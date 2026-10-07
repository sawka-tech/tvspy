import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DataTable } from '../src/components/ui/DataTable';
import { SecretField } from '../src/components/ui/SecretField';
import { StatusChip } from '../src/components/ui/StatusChip';
import { Sparkline } from '../src/components/viz/Sparkline';
import { snrLabel, snrTone } from '../src/components/viz/snr';

function SecretHarness({
  isSet,
  onValue,
}: {
  isSet: boolean;
  onValue: (v: string | null | undefined) => void;
}) {
  const [value, setValue] = useState<string | null | undefined>(undefined);
  return (
    <SecretField
      label="Password"
      isSet={isSet}
      value={value}
      onChange={(v) => {
        setValue(v);
        onValue(v);
      }}
    />
  );
}

describe('SecretField', () => {
  it('never shows a stored secret and lets you replace, remove or keep it', async () => {
    const user = userEvent.setup();
    const values: (string | null | undefined)[] = [];
    render(<SecretHarness isSet onValue={(v) => values.push(v)} />);
    expect(screen.getByText('Saved (hidden)')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('Will be removed when you save')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Keep' }));
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await user.type(screen.getByLabelText('Password'), 'n3w');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(values).toEqual([null, undefined, '', 'n', 'n3', 'n3w', undefined]);
  });

  it('is a plain password input while nothing is stored', async () => {
    const user = userEvent.setup();
    const values: (string | null | undefined)[] = [];
    render(<SecretHarness isSet={false} onValue={(v) => values.push(v)} />);
    const input = screen.getByLabelText('Password') as HTMLInputElement;
    expect(input.type).toBe('password');
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input.type).toBe('text');
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});

describe('DataTable', () => {
  it('marks the sorted column and asks for a new sort on click', async () => {
    const onSort = vi.fn();
    render(
      <DataTable
        columns={[
          { key: 'n', header: 'Name', sort: 'user', cell: (r: { id: number; n: string }) => r.n },
          { key: 'x', header: 'Plain', cell: () => 'x' },
        ]}
        rows={[
          { id: 1, n: 'kapi' },
          { id: 2, n: 'ola' },
        ]}
        rowKey={(r) => r.id}
        sort="user"
        dir="asc"
        onSort={onSort}
      />,
    );
    expect(screen.getByRole('columnheader', { name: /Name/ }).getAttribute('aria-sort')).toBe('ascending');
    expect(screen.getByRole('columnheader', { name: 'Plain' }).getAttribute('aria-sort')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(onSort).toHaveBeenCalledWith('user');
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });
});

describe('status and charts', () => {
  it('always pairs a status colour with a label', () => {
    render(<StatusChip tone="critical">Missing</StatusChip>);
    expect(screen.getByText('Missing')).toBeTruthy();
    const t = { snrGoodDb: 26, snrCriticalDb: 20 };
    expect([30, 26, 22, 19.9, null].map((v) => [snrTone(v, t), snrLabel(v, t)])).toEqual([
      ['good', 'Good'],
      ['good', 'Good'],
      ['warning', 'Weak'],
      ['critical', 'Critical'],
      ['neutral', 'No lock'],
    ]);
  });

  it('lets keyboard users step through a sparkline', () => {
    render(
      <Sparkline values={[1e6, 2e6, 4e6]} format={(v) => `${v / 1e6} Mbit/s`} label="Rate" stepSec={3} />,
    );
    const slider = screen.getByRole('slider', { name: 'Rate' });
    expect(slider.getAttribute('aria-valuetext')).toBe('4 Mbit/s, now');
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(slider.getAttribute('aria-valuetext')).toBe('2 Mbit/s, 3 s ago');
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(slider.getAttribute('aria-valuetext')).toBe('1 Mbit/s, 6 s ago');
  });
});
