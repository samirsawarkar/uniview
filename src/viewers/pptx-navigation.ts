export interface NavSlide {
  hidden?: boolean;
}

/**
 * Returns the slide index to display when entering presenter mode.
 * If the current slide is not hidden, keeps it.
 * If the current slide is hidden, searches forward for the first non-hidden slide;
 * if none found forward, searches backward.
 * If all slides are hidden or the list is empty, returns -1.
 */
export function findPresenterEntrySlide(slides: NavSlide[], current: number = 0): number {
  if (!slides.length) return -1;
  const clamped = Math.max(0, Math.min(slides.length - 1, current));
  if (!slides[clamped]?.hidden) return clamped;

  // Search forward for the next non-hidden slide
  for (let i = clamped + 1; i < slides.length; i++) {
    if (!slides[i]?.hidden) return i;
  }
  // Search backward for the previous non-hidden slide
  for (let i = clamped - 1; i >= 0; i--) {
    if (!slides[i]?.hidden) return i;
  }
  return -1;
}

/**
 * Returns the index of the next non-hidden slide after `from`.
 * If already on or past the last non-hidden slide, returns `from`.
 */
export function findNextSlide(slides: NavSlide[], from: number): number {
  if (!slides.length) return from;
  for (let i = from + 1; i < slides.length; i++) {
    if (!slides[i]?.hidden) return i;
  }
  return from;
}

/**
 * Returns the index of the previous non-hidden slide before `from`.
 * If already on or before the first non-hidden slide, returns `from`.
 */
export function findPrevSlide(slides: NavSlide[], from: number): number {
  if (!slides.length) return from;
  for (let i = from - 1; i >= 0; i--) {
    if (!slides[i]?.hidden) return i;
  }
  return from;
}

export interface SlideBox {
  top: number;
  height: number;
}

/**
 * Returns the index of the slide with the largest visible height inside the
 * scroll window, so a slide shorter than half the panel cannot lose to the one
 * below it. A tie goes to the earlier slide; an empty list returns -1.
 */
export function findVisibleSlide(boxes: SlideBox[], scrollTop: number, clientHeight: number): number {
  const bottom = scrollTop + clientHeight;
  let best = -1;
  let bestVisible = -Infinity;
  boxes.forEach((b, i) => {
    const visible = Math.min(b.top + b.height, bottom) - Math.max(b.top, scrollTop);
    if (visible > bestVisible) {
      best = i;
      bestVisible = visible;
    }
  });
  return best;
}
