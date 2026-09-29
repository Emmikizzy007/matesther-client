import { pbkdf2Sync, randomBytes, timingSafeEqual } from "crypto";

const ITERATIONS = 210000;
const KEYLEN = 32;
const DIGEST = "sha256";

/** Hash a plain password -> "salt:hash" (hex). Safe to store in DB. */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(plain, salt, ITERATIONS, KEYLEN, DIGEST).toString("hex");
  return `${salt}:${hash}`;
}

/** Verify a plain password against a stored "salt:hash" value. */
export function verifyPassword(plain: string, stored: string | null | undefined): boolean {
  if (!stored || !stored.includes(":")) return false;
  try {
    const [salt, expectedHex] = stored.split(":");
    const actual = pbkdf2Sync(plain, salt, ITERATIONS, KEYLEN, DIGEST);
    const expected = Buffer.from(expectedHex, "hex");
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
