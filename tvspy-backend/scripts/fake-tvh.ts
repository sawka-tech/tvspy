// A fake TVHeadend for frontend work and demos: npx tsx scripts/fake-tvh.ts [--scenario evening|idle] [--port 19981]
// Login spy / secret-pass (Digest). Counters, rates and SNR move every 3 seconds.

import { parseArgs } from 'node:util';
import {
  catalogFixture,
  idleInput,
  input,
  startFakeTvh,
  subscription,
  TUNER_A,
  TUNER_B,
} from '../test/support/fakeTvh.js';

const { values } = parseArgs({
  options: { scenario: { type: 'string', default: 'evening' }, port: { type: 'string', default: '19981' } },
});
const now = () => Math.floor(Date.now() / 1000);
const t0 = now();
const tvh = await startFakeTvh(catalogFixture(), Number(values.port));
const jitter = (base: number, spread: number) => base + (Math.random() - 0.5) * spread;

const subs =
  values.scenario === 'idle'
    ? []
    : [
        subscription({
          id: 11,
          start: t0 - 3725,
          username: 'kapi',
          channel: 'TVP1',
          hostname: '77.65.111.65',
        }),
        subscription({
          id: 12,
          start: t0 - 1250,
          username: 'ola',
          channel: 'TVN',
          hostname: '172.17.0.5',
          client: 'SparkleTV/1.9.4 (AFTSSS, Android 9)',
          service: `${TUNER_B}/dvb-t/530MHz/TVN`,
        }),
        subscription({
          id: 13,
          start: t0 - 95,
          username: null,
          channel: 'TVP1',
          hostname: '192.168.1.50',
          client: 'VLC/3.0.21 LibVLC/3.0.21',
        }),
        subscription({
          id: 14,
          start: t0 - 600,
          hostname: null,
          username: 'admin',
          client: null,
          title: 'DVR: Fakty',
          channel: 'TVN',
          service: `${TUNER_B}/dvb-t/530MHz/TVN`,
        }),
      ];
tvh.state.subscriptions = subs;

const tick = () => {
  for (const s of subs) {
    const rate = jitter(600_000, 150_000);
    s.in = Math.round(rate);
    s.out = Math.round(rate);
    s.total_out =
      (s.total_out as number) +
      Math.round(rate * 3) +
      (s.total_out === 0 ? Math.round(rate * (now() - (s.start as number))) : 0);
  }
  tvh.state.inputs =
    values.scenario === 'idle'
      ? [idleInput(TUNER_A), idleInput(TUNER_B)]
      : [
          input({
            snr: Math.round(jitter(31_500, 800)),
            signal: -54_000,
            subs: 2,
            bps: Math.round(jitter(9e6, 1e6)),
          }),
          input({
            input: TUNER_B,
            stream: '530MHz in dvb-t',
            snr: Math.round(jitter(23_800, 1200)),
            signal: -63_000,
            subs: 2,
            bps: Math.round(jitter(8e6, 1e6)),
          }),
        ];
};
tick();
setInterval(tick, 3000);
console.log(`fake TVHeadend (${values.scenario}) on ${tvh.url} — login spy / secret-pass`);
