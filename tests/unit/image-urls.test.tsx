import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { metafileToPng } from '../../src/viewers/metafile';
import { useImageUrls } from '../../src/viewers/PptxViewer';

vi.mock('../../src/viewers/metafile', () => ({ metafileToPng: vi.fn() }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Presentation = NonNullable<Parameters<typeof useImageUrls>[0]>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const OriginalURL = globalThis.URL;

class MockURL extends OriginalURL {
  static override createObjectURL = vi.fn((_blob: Blob | MediaSource) => `blob:mock-${Math.random().toString(36).slice(2)}`);
  static override revokeObjectURL = vi.fn((_url: string) => {});
}

function Harness({ pres, part }: { pres: Presentation | null; part: string }) {
  const urls = useImageUrls(pres);
  return <img data-testid="img" src={urls(part)} alt="" />;
}

function makeFakePresentation(entries: Array<{ name: string; size?: number; bytes?: Uint8Array }>): Presentation {
  return {
    pkg: {
      entries: entries.map((e) => ({
        name: e.name,
        size: e.size ?? (e.bytes?.length ?? 100),
      })),
      bytesOf: (name: string) => {
        const found = entries.find((e) => e.name === name);
        return found ? (found.bytes ?? new Uint8Array([1, 2, 3])) : null;
      },
    },
  } as unknown as Presentation;
}

describe('useImageUrls lifecycle', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('URL', MockURL);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    vi.unstubAllGlobals();
  });

  it('1 resolved conversion displays blob URL; unmount revokes it', async () => {
    const deferred = createDeferred<Blob | null>();
    vi.mocked(metafileToPng).mockImplementation(() => deferred.promise);

    const pres = makeFakePresentation([{ name: 'ppt/media/image1.emf', size: 100 }]);
    const blob = new Blob(['png-data'], { type: 'image/png' });

    await act(async () => {
      root!.render(<Harness pres={pres} part="ppt/media/image1.emf" />);
    });

    const img = container!.querySelector('img');
    expect(img?.getAttribute('src')).toBeFalsy();

    await act(async () => {
      deferred.resolve(blob);
    });

    const blobUrl = img?.getAttribute('src');
    expect(blobUrl).toMatch(/^blob:/);
    expect(MockURL.createObjectURL).toHaveBeenCalledWith(blob);

    await act(async () => {
      root!.unmount();
      root = null;
    });

    expect(MockURL.revokeObjectURL).toHaveBeenCalledWith(blobUrl);
  });

  it('2 unmount while pending then resolveBlob => no createObjectURL and no state update', async () => {
    const deferred = createDeferred<Blob | null>();
    vi.mocked(metafileToPng).mockImplementation(() => deferred.promise);

    const pres = makeFakePresentation([{ name: 'ppt/media/image1.emf', size: 100 }]);
    const blob = new Blob(['png-data'], { type: 'image/png' });

    await act(async () => {
      root!.render(<Harness pres={pres} part="ppt/media/image1.emf" />);
    });

    await act(async () => {
      root!.unmount();
      root = null;
    });

    const createCountBefore = MockURL.createObjectURL.mock.calls.length;

    await act(async () => {
      deferred.resolve(blob);
    });

    expect(MockURL.createObjectURL).toHaveBeenCalledTimes(createCountBefore);
  });

  it('3 replace pres A with B before A resolves; resolve A => no URL; resolve B => only B URL; unmount revokes B', async () => {
    const deferredA = createDeferred<Blob | null>();
    const deferredB = createDeferred<Blob | null>();

    let callCount = 0;
    vi.mocked(metafileToPng).mockImplementation(() => {
      callCount++;
      return callCount === 1 ? deferredA.promise : deferredB.promise;
    });

    const presA = makeFakePresentation([{ name: 'ppt/media/imageA.emf', size: 100 }]);
    const presB = makeFakePresentation([{ name: 'ppt/media/imageB.emf', size: 100 }]);

    const blobA = new Blob(['png-A'], { type: 'image/png' });
    const blobB = new Blob(['png-B'], { type: 'image/png' });

    await act(async () => {
      root!.render(<Harness pres={presA} part="ppt/media/imageA.emf" />);
    });

    await act(async () => {
      root!.render(<Harness pres={presB} part="ppt/media/imageB.emf" />);
    });

    await act(async () => {
      deferredA.resolve(blobA);
    });

    expect(MockURL.createObjectURL).not.toHaveBeenCalledWith(blobA);
    const img = container!.querySelector('img');
    expect(img?.getAttribute('src')).toBeFalsy();

    await act(async () => {
      deferredB.resolve(blobB);
    });

    expect(MockURL.createObjectURL).toHaveBeenCalledWith(blobB);
    const urlB = img?.getAttribute('src');
    expect(urlB).toMatch(/^blob:/);

    await act(async () => {
      root!.unmount();
      root = null;
    });

    expect(MockURL.revokeObjectURL).toHaveBeenCalledWith(urlB);
    expect(MockURL.revokeObjectURL).not.toHaveBeenCalledWith(expect.stringMatching(/blobA/));
  });
});
