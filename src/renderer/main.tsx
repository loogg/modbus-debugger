import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './shell';
import { useApp } from './store/app';
import './i18n';
import './styles.css';
import { resolveAppTransport } from './transport';
import { DevReviewIndicator } from './components/dev-review-indicator';
import type { ScriptEditorWindow } from './features/scripts/editor-host';

const isWindowHost = new URLSearchParams(window.location.search).has('viewHost');
if (isWindowHost) {
  (window as ScriptEditorWindow).mountMasterScriptEditor = async (element, input) => {
    const { mountScriptEditor } = await import('./features/scripts/editor-host');
    return element.ownerDocument === document && element.isConnected ? mountScriptEditor(element, input) : null;
  };
  document.documentElement.dataset.viewHost = 'ready';
}

const transport = isWindowHost ? null : resolveAppTransport();
const root = createRoot(document.getElementById('root') as HTMLElement);

if (transport) root.render(
  <React.StrictMode>
    <App />
    <DevReviewIndicator transport={transport} />
  </React.StrictMode>,
);

async function start() {
  if (!transport) return;
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
