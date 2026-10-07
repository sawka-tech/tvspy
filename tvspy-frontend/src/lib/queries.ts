// Server state. Polling stops while the tab is in the background (TanStack Query's default).

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  About,
  Alerts,
  AuthState,
  Live,
  LoginRequest,
  Lookups,
  PasswordChangeRequest,
  SessionSort,
  Sessions,
  Settings,
  SettingsPatch,
  SetupRequest,
  Status,
  TelegramTestRequest,
  TestResult,
  Tuners,
  TvhTestRequest,
} from '@tvspy/shared';
import { api, query } from './api';

export const keys = {
  auth: ['auth'] as const,
  status: ['status'] as const,
  live: ['live'] as const,
  tuners: ['tuners'] as const,
  sessions: (p: SessionQuery) => ['sessions', p] as const,
  lookups: ['lookups'] as const,
  settings: ['settings'] as const,
  alerts: (page: number) => ['alerts', page] as const,
  about: ['about'] as const,
};

export const useAuth = () =>
  useQuery({ queryKey: keys.auth, queryFn: () => api<AuthState>('GET', '/api/auth') });

export const useStatus = () =>
  useQuery({
    queryKey: keys.status,
    queryFn: () => api<Status>('GET', '/api/status'),
    refetchInterval: 10_000,
  });

export const useLive = () =>
  useQuery({ queryKey: keys.live, queryFn: () => api<Live>('GET', '/api/live'), refetchInterval: 3_000 });

export const useTuners = () =>
  useQuery({
    queryKey: keys.tuners,
    queryFn: () => api<Tuners>('GET', '/api/tuners'),
    refetchInterval: 5_000,
  });

export interface SessionQuery {
  page?: number;
  pageSize?: number;
  sort?: SessionSort;
  dir?: 'asc' | 'desc';
  kind?: 'playback' | 'recording';
  user?: string;
  channel?: string;
  app?: string;
  outcome?: 'ok' | 'failed';
  from?: string;
  to?: string;
  minSec?: number;
  q?: string;
  visit?: number;
  ended?: boolean;
}

export const useSessions = (p: SessionQuery, opts: { refetchInterval?: number } = {}) =>
  useQuery({
    queryKey: keys.sessions(p),
    queryFn: () => api<Sessions>('GET', `/api/sessions${query({ ...p })}`),
    placeholderData: keepPreviousData,
    refetchInterval: opts.refetchInterval,
  });

export const useLookups = () =>
  useQuery({
    queryKey: keys.lookups,
    queryFn: () => api<Lookups>('GET', '/api/lookups'),
    staleTime: 300_000,
  });

export const useSettings = () =>
  useQuery({ queryKey: keys.settings, queryFn: () => api<Settings>('GET', '/api/settings') });

export const useAlerts = (page: number) =>
  useQuery({
    queryKey: keys.alerts(page),
    queryFn: () => api<Alerts>('GET', `/api/alerts${query({ page, pageSize: 50 })}`),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

export const useAbout = () =>
  useQuery({ queryKey: keys.about, queryFn: () => api<About>('GET', '/api/about') });

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) => api<AuthState>('POST', '/api/auth/login', body),
    onSuccess: (state) => qc.setQueryData(keys.auth, state),
  });
}

export function useSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SetupRequest) => api<AuthState>('POST', '/api/auth/setup', body),
    onSuccess: (state) => qc.setQueryData(keys.auth, state),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<AuthState>('POST', '/api/auth/logout'),
    onSettled: () => {
      qc.clear();
      qc.setQueryData(keys.auth, { authenticated: false, setupRequired: false, username: null });
    },
  });
}

export const useChangePassword = () =>
  useMutation({ mutationFn: (body: PasswordChangeRequest) => api<void>('PUT', '/api/auth/password', body) });

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => api<Settings>('PATCH', '/api/settings', patch),
    onSuccess: (settings) => {
      qc.setQueryData(keys.settings, settings);
      void qc.invalidateQueries({ queryKey: keys.status });
    },
  });
}

export const useTestTvh = () =>
  useMutation({
    mutationFn: (body: TvhTestRequest) => api<TestResult>('POST', '/api/settings/tvh/test', body),
  });

export const useTestTelegram = () =>
  useMutation({
    mutationFn: (body: TelegramTestRequest) => api<TestResult>('POST', '/api/settings/telegram/test', body),
  });
