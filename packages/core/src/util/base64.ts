/**
 * Portable base64 helpers (Node ≥ 22 and browsers). `btoa`/`atob` are global
 * in both. Input is processed in slices to avoid call-stack limits on large arrays.
 */
const SLICE = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += SLICE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + SLICE));
  }
  return btoa(binary);
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** @throws {TypeError} on malformed base64 input. */
export function base64ToBytes(text: string): Uint8Array {
  if (text.length % 4 !== 0 || !BASE64_RE.test(text)) throw new TypeError('Malformed base64 data');
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
