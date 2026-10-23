import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';

import App from './App.js';
import { queryClient } from './blaze.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('blaze-example: #root is missing');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
