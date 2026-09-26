import { describe, expect, it } from 'vitest';
import { clampToWorkAreas } from '../../src/main/window-bounds';

describe('restored window bounds', () => {
  const primary = { x: 0, y: 0, width: 1440, height: 900 };
  const secondary = { x: 1440, y: 0, width: 1920, height: 1080 };

  it('keeps an already visible window unchanged', () => {
    expect(clampToWorkAreas({ x: 100, y: 80, width: 1024, height: 680 }, [primary])).toEqual({ x: 100, y: 80, width: 1024, height: 680 });
  });

  it('moves a partly offscreen window fully inside the display', () => {
    expect(clampToWorkAreas({ x: 900, y: 500, width: 1024, height: 680 }, [primary])).toEqual({ x: 416, y: 220, width: 1024, height: 680 });
  });

  it('uses the display with greatest overlap and recovers after a display is removed', () => {
    expect(clampToWorkAreas({ x: 1300, y: 100, width: 1024, height: 680 }, [primary, secondary])).toEqual({ x: 1440, y: 100, width: 1024, height: 680 });
    expect(clampToWorkAreas({ x: 2100, y: 100, width: 1024, height: 680 }, [primary])).toEqual({ x: 416, y: 100, width: 1024, height: 680 });
  });
});
