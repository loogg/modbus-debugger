import { describe, expect, it } from 'vitest';
import { pointSchema } from '../../src/domain/model';
import { formatEngineeringNumber, resolveDecimalPlaces } from '../../src/domain/point-format';

describe('point display precision', () => {
  it('rounds only the display text and trims unnecessary trailing zeros', () => {
    const original = 48.5990173339844;
    expect(formatEngineeringNumber(original)).toBe('48.599');
    expect(formatEngineeringNumber(original, 2)).toBe('48.6');
    expect(formatEngineeringNumber(original, 0)).toBe('49');
    expect(formatEngineeringNumber(-0.0001, 2)).toBe('0');
    expect(original).toBe(48.5990173339844);
  });

  it('uses the default for older points and rejects invalid stored settings', () => {
    const point = {
      id: 'p1', blockId: 'b1', name: '电压',
      mapping: { rawType: 'Float32', offset: 0, registerCount: 2, wordOrder: 'ABCD', byteSelector: 'low', bitOffset: 0, bitWidth: 16, stringLength: 0, stringEncoding: 'ascii' },
      scale: 1, offset: 0, unit: 'V', access: 'ro', displayFormat: 'auto', enumMap: {}, highRisk: false, description: '',
    };
    expect(pointSchema.parse(point).decimalPlaces).toBeUndefined();
    expect(resolveDecimalPlaces(pointSchema.parse(point).decimalPlaces)).toBe(3);
    expect(pointSchema.parse({ ...point, decimalPlaces: 12 }).decimalPlaces).toBe(12);
    expect(pointSchema.safeParse({ ...point, decimalPlaces: -1 }).success).toBe(false);
    expect(pointSchema.safeParse({ ...point, decimalPlaces: 13 }).success).toBe(false);
    expect(pointSchema.safeParse({ ...point, decimalPlaces: 1.5 }).success).toBe(false);
  });
});
