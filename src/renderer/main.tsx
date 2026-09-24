import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './shell';
import { useApp } from './store/app';
import './i18n';
import './styles.css';
import { resolveAppTransport } from './transport';
import { DevReviewIndicator } from './components/dev-review-indicator';

const transport = resolveAppTransport();
const root = createRoot(document.getElementById('root') as HTMLElement);

root.render(
  <React.StrictMode>
    <App />
    <DevReviewIndicator transport={transport} />
  </React.StrictMode>,
);

async function start() {
  try {
    await useApp.getState().init(transport);
  } catch (err) {
    console.warn('[Transport] Initial snapshot load pending or failed:', err);
    // Listen for connection recovery
    transport.onStatusChange(async (state) => {
      if (state.status === 'connected' && !useApp.getState().snapshot) {
        try {
          await useApp.getState().init(transport);
        } catch (e) {
          console.error('[Transport] Reconnection init failed:', e);
        }
      }
    });
  }
}

void start();