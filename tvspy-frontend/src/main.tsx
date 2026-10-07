import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, createQueryClient } from './App';
import { applyTheme, storedTheme } from './lib/theme';
import './styles.css';

applyTheme(storedTheme());

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App client={createQueryClient()} />
    </StrictMode>,
  );
}
