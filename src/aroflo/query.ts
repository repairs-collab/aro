export type EncodedPair = readonly [key: string, value: string | number | boolean];

export function encodePairs(pairs: readonly EncodedPair[]): string {
  return pairs
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}
