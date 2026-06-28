// Capability tokens + ids. The edit token is high-entropy and only ever stored
// as a sha256 hash; the share code is a short, case-insensitive read capability.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Constant-time secret comparison for admin/cron tokens. A plain `a === b` (or
 * `!==`) short-circuits at the first differing byte, leaking the length of the
 * matching prefix through timing. We sha256 BOTH sides first so the inputs are
 * always equal-length (timingSafeEqual throws on length mismatch, which itself
 * leaks length) and the raw secret length isn't observable either. Returns false
 * for any falsy input so an unset server secret never matches.
 */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Crockford base32 — no I/L/O/U, case-insensitive, QR/handwriting-safe.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function crockford(byteLen: number): string {
  const bytes = randomBytes(byteLen);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += CROCKFORD[bytes[i]! & 31];
  return out;
}

/** 256-bit base64url edit token (the write capability). */
export function randomEditToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** ~12-char Crockford code (~60 bits) — the read-only /s/ capability. */
export function randomShareCode(): string {
  return crockford(12);
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 48) || "list"
  );
}

/** Human-readable public address: {slug}-{6 Crockford}. Suffix prevents collisions only. */
export function randomSlug(title: string): string {
  return `${slugify(title)}-${crockford(6).toLowerCase()}`;
}
