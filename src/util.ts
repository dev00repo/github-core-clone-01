// Small shared helpers: hashing, ids, base64. Node stdlib only.

import { createHash } from 'node:crypto';

/** The all-zero object id: "no object" in ref updates and deletions. */
export const ZERO_OID = '0'.repeat(40);

/** True when `s` is a 40-hex object id. */
export function isHex40(s: string): boolean {
  return /^[0-9a-f]{40}$/i.test(s);
}

/** SHA-1 of `data` as 20 raw bytes. */
export function sha1Buf(data: Buffer | string): Buffer {
  return createHash('sha1').update(data).digest();
}

/** SHA-1 of `data` as 40 lowercase hex characters. */
export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Base64 of `data` (standard alphabet, padded), as a string. */
export function b64encode(data: Buffer): string {
  return data.toString('base64');
}

/** Decode standard base64; returns null when the text is not valid base64. */
export function b64decode(text: string): Buffer | null {
  const cleaned = text.replace(/\s+/g, '');
  if (cleaned.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(cleaned)) return null;
  try {
    return Buffer.from(cleaned, 'base64');
  } catch {
    return null;
  }
}

/** Compare two buffers byte by byte (like memcmp); for git byte order. */
export function compareBytes(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = a[i] - b[i];
    if (d !== 0) return d;
  }
  return a.length - b.length;
}
