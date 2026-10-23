export function safePptxLink(value?: string): string | undefined {
  if (!value || typeof value !== 'string') {
    return undefined;
  }

  // Reject original raw controls BEFORE trim
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
      return trimmed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
