import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './shell';
import { useApp } from './store/app';
import './i18n';
import type { ModbusApi } from '../shared/preload-api';
import './styles.css';

const api = (window as unknown as { modbus: ModbusApi }).modbus;
const root = createRoot(document.getElementById('root') as HTMLElement);
root.render(<App />);
void useApp.getState().init(api);