import { describe, it, expect, vi } from 'vitest';
// @ts-ignore
import { getHeapMeasurement } from '../../scripts/bench-metrics.mjs';

describe('getHeapMeasurement invalid metrics', () => {
  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-1', -1],
  ])('returns null and detaches client when JSHeapUsedSize is %s', async (_name, invalidValue) => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const fakeClient = {
      send: vi.fn().mockResolvedValue({
        metrics: [
          { name: 'JSHeapUsedSize', value: invalidValue },
        ],
      }),
      detach: vi.fn().mockResolvedValue(undefined),
    };

    const fakePage = {
      context: () => ({
        newCDPSession: vi.fn().mockResolvedValue(fakeClient),
      }),
    };

    const result = await getHeapMeasurement(fakePage);

    expect(result).toBeNull();
    expect(fakeClient.detach).toHaveBeenCalled();

    consoleWarnSpy.mockRestore();
  });
});
