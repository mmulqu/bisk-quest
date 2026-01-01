/**
 * AES-256-GCM encryption using Web Crypto API (Cloudflare Workers compatible)
 */

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function importAesKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64ToBytes(keyB64);
  if (raw.length !== 32) {
    throw new Error("ENCRYPTION_KEY_B64 must decode to 32 bytes");
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * Encrypt plaintext string to base64-encoded ciphertext
 * Format: iv (12 bytes) || ciphertext (includes auth tag)
 */
export async function encryptToB64(plaintext: string, keyB64: string): Promise<string> {
  const key = await importAesKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(plaintext);
  
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt)
  );
  
  // Pack: iv || ciphertext
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  
  return bytesToB64(packed);
}

/**
 * Decrypt base64-encoded ciphertext to plaintext string
 */
export async function decryptFromB64(encB64: string, keyB64: string): Promise<string> {
  const key = await importAesKey(keyB64);
  const packed = b64ToBytes(encB64);
  
  const iv = packed.slice(0, 12);
  const ct = packed.slice(12);
  
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}
