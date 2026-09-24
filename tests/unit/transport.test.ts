// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { MockTransport } from '../../src/renderer/transport/mock';
import { resolveAppTransport } from '../../src/renderer/transport';

describe('Renderer Transports', () => {
  describe('MockTransport', () => {
    it('initializes default mock fixture with points and connections', async () => {
      const mock = new MockTransport('default');
      const snap = await mock.getSnapshot();

      expect(snap.workspace.connections.length).toBeGreaterThan(0);
      expect(snap.workspace.templates.length).toBeGreaterThan(0);
      expect(Object.keys(snap.points).length).toBeGreaterThan(0);

      const status = mock.getStatus();
      expect(status.type).toBe('mock');
      expect(status.status).toBe('connected');

      mock.dispose();
    });

    it('initializes empty mock fixture with 0 connections and 0 templates', async () => {
      const mock = new MockTransport('empty');
      const snap = await mock.getSnapshot();

      expect(snap.workspace.connections.length).toBe(0);
      expect(snap.workspace.templates.length).toBe(0);
      expect(Object.keys(snap.points).length).toBe(0);

      mock.dispose();
    });

    it('handles point write and workspace commands in mock', async () => {
      const mock = new MockTransport('default');
      const res = await mock.command({
        type: 'connection.connect',
        connectionId: 'c_tcp',
      });
      expect(res.ok).toBe(true);

      const snap = await mock.getSnapshot();
      expect(snap.connections['c_tcp']?.state).toBe('online');

      mock.dispose();
    });

    it('handles simulated error fixture', async () => {
      const mock = new MockTransport('error');
      const res = await mock.command({ type: 'connection.connect', connectionId: 'c_tcp' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('Mock fixture: error');
      mock.dispose();
    });
  });

  describe('resolveAppTransport', () => {
    it('resolves MockTransport when ?transport=mock is set', () => {
      const transport = resolveAppTransport('http://localhost:5173/?transport=mock&fixture=empty');
      expect(transport.transportType).toBe('mock');
      expect(transport.getStatus().fixture).toBe('empty');
      transport.dispose?.();
    });

    it('resolves BridgeTransport when ?transport=bridge is set', () => {
      const transport = resolveAppTransport('http://localhost:5173/?transport=bridge');
      expect(transport.transportType).toBe('bridge');
      transport.dispose?.();
    });
  });
});
