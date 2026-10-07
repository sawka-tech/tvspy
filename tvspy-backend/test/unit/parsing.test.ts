import { describe, expect, it } from 'vitest';
import { parseClient } from '../../src/core/clientParse.js';
import { classifyRoute, inCidr, isValidCidr, parseIp } from '../../src/core/ip.js';
import {
  isClientOrRecording,
  muxFrequencyMHz,
  parseInput,
  parseService,
  parseStream,
  parseSubscription,
  subKey,
} from '../../src/core/tvhParse.js';

describe('TVH payload parsing', () => {
  it('splits the service nicename into tuner, network, mux and service', () => {
    expect(parseService('Silicon Labs Si2168 #3 : DVB-T #0/dvb-t/490MHz/TVP1')).toEqual({
      tuner: 'Silicon Labs Si2168 #3 : DVB-T #0',
      network: 'dvb-t',
      mux: '490MHz',
      service: 'TVP1',
    });
    expect(parseService('dvb-t/205.5MHz/Nowa TV')).toEqual({
      tuner: null,
      network: 'dvb-t',
      mux: '205.5MHz',
      service: 'Nowa TV',
    });
    expect(parseService('TVN').service).toBe('TVN');
    expect(parseService(null).mux).toBeNull();
  });

  it('reads mux and frequency from an input stream name', () => {
    expect(parseStream('490MHz in dvb-t')).toEqual({ mux: '490MHz', network: 'dvb-t' });
    expect(parseStream('')).toEqual({ mux: null, network: null });
    expect(muxFrequencyMHz('205.5MHz')).toBe(205.5);
    expect(muxFrequencyMHz('House Nation UK')).toBeNull();
  });

  it('normalizes a tuned input with decibel statistics', () => {
    const input = parseInput({
      input: 'Silicon Labs Si2168 #0 : DVB-T #0',
      stream: '490MHz in dvb-t',
      subs: 1,
      weight: 100,
      signal: -54000,
      signal_scale: 2,
      snr: 31800,
      snr_scale: 2,
      unc: 0,
      bps: 4_000_000,
    });
    expect(input).toMatchObject({ mux: '490MHz', locked: true, snrDb: 31.8, signalDbm: -54, weight: 100 });
  });

  it('treats an idle tuner and a tuned tuner without lock as unlocked', () => {
    expect(parseInput({ input: 'T0', stream: '', snr_scale: 0 })).toMatchObject({ mux: null, locked: false });
    expect(parseInput({ input: 'T0', stream: '530MHz in dvb-t', snr_scale: 0, bps: 0 })?.locked).toBe(false);
    expect(parseInput({ stream: 'x' })).toBeNull();
  });

  it('normalizes subscriptions and recognizes internal ones', () => {
    const sub = parseSubscription({
      id: 24,
      start: 1791363858,
      hostname: '192.168.1.70',
      title: 'HTTP',
      total_in: 5,
    });
    expect(sub).toMatchObject({ id: 24, username: null, totalIn: 5, rateOut: 0 });
    expect(sub && subKey(sub)).toBe('1791363858-24');
    expect(isClientOrRecording({ hostname: null, title: 'epggrab' })).toBe(false);
    expect(isClientOrRecording({ hostname: null, title: 'DVR: Fakty' })).toBe(true);
    expect(isClientOrRecording({ hostname: '1.2.3.4', title: 'HTTP' })).toBe(true);
    expect(parseSubscription({ start: 1 })).toBeNull();
  });
});

describe('client strings', () => {
  it.each([
    [
      'SparkleTV/1.9.6 (AFTMM, Android 7.1.2)',
      { app: 'SparkleTV', version: '1.9.6', device: 'Fire TV Stick 4K', platform: 'Android 7.1.2' },
    ],
    [
      'SparkleTV/2.1.1 (Pixel 8, Android 17)',
      { app: 'SparkleTV', device: 'Pixel 8', platform: 'Android 17' },
    ],
    ['VLC/3.0.20 LibVLC/3.0.20', { app: 'VLC', version: '3.0.20' }],
    ['Kodi Media Center', { app: 'Kodi', version: null }],
    ['okhttp/4.12.0', { app: 'okhttp', version: '4.12.0' }],
    ['TiviMate/5.1.6 (Android 11)', { app: 'TiviMate', platform: 'Android 11' }],
    ['SomethingNew/1.0', { app: 'SomethingNew', version: '1.0' }],
  ])('parses %s', (raw, expected) => {
    expect(parseClient(raw)).toMatchObject(expected);
  });

  it('returns null for empty values', () => {
    expect(parseClient('')).toBeNull();
    expect(parseClient(undefined)).toBeNull();
  });
});

describe('IP routes', () => {
  it('parses IPv4, IPv6 and IPv4-mapped addresses', () => {
    expect(parseIp('192.168.1.70')).toEqual({ v: 4, n: 0xc0a80146n });
    expect(parseIp('::ffff:192.168.1.70')).toEqual({ v: 4, n: 0xc0a80146n });
    expect(parseIp('2a01:110::1')?.v).toBe(6);
    expect(parseIp('300.1.1.1')).toBeNull();
    expect(parseIp('nonsense')).toBeNull();
  });

  it('matches CIDRs', () => {
    expect(inCidr('172.17.0.7', '172.17.0.0/16')).toBe(true);
    expect(inCidr('172.18.0.7', '172.17.0.0/16')).toBe(false);
    expect(inCidr('fd00::1', 'fc00::/7')).toBe(true);
    expect(isValidCidr('10.0.0.0/33')).toBe(false);
    expect(isValidCidr('192.168.8.0/24')).toBe(true);
  });

  it('classifies proxy before LAN, then direct', () => {
    expect(classifyRoute('172.17.0.7')).toBe('proxy');
    expect(classifyRoute('192.168.1.70')).toBe('lan');
    expect(classifyRoute('10.107.67.4')).toBe('lan');
    expect(classifyRoute('77.65.111.65')).toBe('direct');
    expect(classifyRoute(null)).toBe('none');
    expect(classifyRoute('162.0.0.1', { proxyCidrs: [], lanCidrs: ['162.0.0.0/8'] })).toBe('lan');
  });
});
