import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { ApiError, setUnauthenticatedHandler } from './api/client';
import { App } from './App';
import { SESSION_KEY } from './session';
import { applyTheme, loadTheme } from './lib/theme';
import './styles.css';

applyTheme(loadTheme());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      // Retry only on network failures and retryable errors; 4xx (not_found, forbidden) are not retried.
      retry: (count, err) => count < 2 && (!(err instanceof ApiError) || err.status === 0 || err.status >= 500),
    },
  },
});

// The session expired or was revoked: forget the data and show login.
setUnauthenticatedHandler(() => {
  queryClient.clear();
  queryClient.setQueryData(SESSION_KEY, null);
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
