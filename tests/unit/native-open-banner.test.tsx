import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/ui/App';
import { getBridge } from '../../src/shells';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../src/ui/TabView', () => ({
  TabView: () => null,
}));

vi.mock('../../src/shells', () => ({
  getBridge: vi.fn(),
}));

describe('native-open-banner', () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    if (container) {
      container.remove();
      container = null;
    }
    root = null;
    document.body.innerHTML = '';
  });

  it('subscribes to onExternalOpenError, displays warning banner on error, and unsubscribes on unmount', async () => {
    const unsubscribeMock = vi.fn();
    let errorCallback: ((message: string) => void) | undefined;
    const subscribeMock = vi.fn((cb: (message: string) => void) => {
      errorCallback = cb;
      return unsubscribeMock;
    });

    const bridge = {
      kind: 'capacitor' as const,
      pickFiles: vi.fn(async () => []),
      onExternalOpen: vi.fn(() => () => {}),
      onExternalOpenError: subscribeMock,
    };

    vi.mocked(getBridge).mockReturnValue(bridge as any);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(<App />);
    });

    expect(subscribeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      errorCallback?.('Could not open test.pdf');
    });

    const banner = container.querySelector('.banner.warn');
    expect(banner?.textContent).toContain('Could not open test.pdf');

    await act(async () => {
      root!.unmount();
    });

    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });
});
