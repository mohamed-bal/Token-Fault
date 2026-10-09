/**
 * Portable base64 helpers (Node ≥ 22 and browsers).
 *
 * A native encoder is used when the runtime has one (`Uint8Array.prototype.toBase64`
 * or Node's `Buffer`); it is several times faster than the portable path, which
 * matters because the inspector base64-encodes every captured network chunk. The
 * portable `btoa`/`atob` path is used everywhere else. Detection is by feature, so
 * this module never imports Node built-ins and stays browser-safe.
 */
const SLICE = 0x8000;

interface NativeBuffer {
  from(
    data: ArrayBufferLike,
    byteOffset: number,
    length: number,
  ): { toString(encoding: 'base64'): string };
  from(data: string, encoding: 'base64'): Uint8Array;
}
type WithToBase64 = Uint8Array & { toBase64?: () => string };

const nativeBuffer = (globalThis as { Buffer?: NativeBuffer }).Buffer;
const hasToBase64 = typeof (Uint8Array.prototype as WithToBase64).toBase64 === 'function';

export function bytesToBase64(bytes: Uint8Array): string {
  if (hasToBase64) return (bytes as WithToBase64).toBase64!();
  if (nativeBuffer)
    return nativeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
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
  if (nativeBuffer) {
    const decoded = nativeBuffer.from(text, 'base64');
    return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength).slice();
  }
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The portable implementation, exported for equivalence tests. */
export function bytesToBase64Portable(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += SLICE)
    binary += String.fromCharCode(...bytes.subarray(i, i + SLICE));
  return btoa(binary);
}
