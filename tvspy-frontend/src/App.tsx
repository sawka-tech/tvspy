import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Link, useRouteError } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { Layout } from './components/Layout';
import { EmptyState, ErrorNotice } from './components/ui/Feedback';
import { isUnauthenticated } from './lib/api';
import { keys, useAuth } from './lib/queries';
import { ServerProvider } from './lib/server';
import { AlertsPage } from './pages/AlertsPage';
import { LoginPage, NotAvailablePage } from './pages/AuthPages';
import { HistoryPage } from './pages/HistoryPage';
import { LivePage } from './pages/LivePage';
import { SettingsPage } from './pages/SettingsPage';

export function createQueryClient(): QueryClient {
  // Any 401 means the session ended (expired, logged out elsewhere): show the login again.
  const onError = (err: unknown) => {
    if (isUnauthenticated(err)) void client.invalidateQueries({ queryKey: keys.auth });
  };
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        retry: (count, err) => !isUnauthenticated(err) && count < 2,
        refetchOnWindowFocus: true,
        staleTime: 2_000,
      },
    },
  });
  return client;
}

function RouteError() {
  const error = useRouteError();
  return (
    <div className="mx-auto max-w-xl p-6">
      <ErrorNotice error={error} onRetry={() => window.location.reload()} />
    </div>
  );
}

function NotFound() {
  return (
    <EmptyState title="Page not found">
      <Link to="/" className="font-medium text-accent-ink hover:underline">
        Back to Live
      </Link>
    </EmptyState>
  );
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <LivePage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'alerts', element: <AlertsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

/** The app on trusted networks or after logging in; otherwise the login or a "home network only" page. */
function AuthGate() {
  const auth = useAuth();
  if (auth.isPending) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-ink-2">Loading…</div>;
  }
  if (auth.error) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <ErrorNotice error={auth.error} onRetry={() => void auth.refetch()} />
      </div>
    );
  }
  if (!auth.data.authenticated) {
    return auth.data.loginAvailable ? (
      <LoginPage address={auth.data.address} />
    ) : (
      <NotAvailablePage address={auth.data.address} />
    );
  }
  return (
    <ServerProvider>
      <RouterProvider router={router} />
    </ServerProvider>
  );
}

export function App({ client }: { client: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <AuthGate />
    </QueryClientProvider>
  );
}
