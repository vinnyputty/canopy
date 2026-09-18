import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

document.documentElement.dataset.platform = /mac/i.test(navigator.platform)
  ? 'mac'
  : /win/i.test(navigator.platform)
    ? 'windows'
    : 'linux';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
