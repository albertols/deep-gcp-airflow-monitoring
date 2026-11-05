import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { createDcamTheme } from '@dcam/ui-kit';
import { createDcamApi } from './api';
import { App } from './App';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 30_000, staleTime: 15_000 } },
});
const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider theme={createDcamTheme('dark')}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <App api={createDcamApi()} />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
