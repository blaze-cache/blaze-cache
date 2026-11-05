import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.js';
import './style.css';

const container = document.getElementById('root');
if (!container) throw new Error('blaze-example-ky: #root is missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
