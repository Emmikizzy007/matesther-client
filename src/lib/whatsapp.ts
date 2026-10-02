/**
 * WhatsApp deep links for Matesther business documents.
 *
 * These are pure functions so they can be unit-tested without a browser, and so
 * the same normalisation is used everywhere a document can be shared.
 *
 * SAFETY RULES
 *   1. Never guess a phone number. If a number cannot be resolved confidently we
 *      return null and the caller falls back to WhatsApp's own "choose a
 *      contact" link. Opening a chat with the WRONG person is worse than making
 *      the sender pick one.
 *   2. Never put an application URL in a shared message. Matesther's document
 *      pages require an Owner session, so a link would be useless to the
 *      recipient and could only cause confusion.
 *   3. Cap the message length so a long document summary cannot produce a link
 *      that WhatsApp or the browser truncates mid-word.
 */

/** Matesther is a Nigerian business; local numbers are resolved against this. */
export const NIGERIA_COUNTRY_CODE = "234";

/** Long summaries are trimmed so the deep link stays usable. */
export const WHATSAPP_MESSAGE_LIMIT = 1200;

/**
 * Normalise a phone number into the digits-only international form `wa.me`
 * expects, e.g. `0803 123 4567` -> `2348031234567`.
 *
 * Returns `null` when the number cannot be resolved safely.
 */
export function whatsappNumber(
  phone: string | null | undefined,
  countryCode: string = NIGERIA_COUNTRY_CODE
): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (!digits) return null;

  // Already international for this country: +234 803 123 4567
  if (digits.startsWith(countryCode) && digits.length >= countryCode.length + 9) return digits;

  // Local with the trunk zero: 0803 123 4567
  if (digits.startsWith("0")) {
    const local = digits.slice(1);
    return local.length >= 9 && local.length <= 11 ? countryCode + local : null;
  }

  // Local without the trunk zero: 803 123 4567
  if (digits.length >= 9 && digits.length <= 11) return countryCode + digits;

  // Anything else (too short, or a foreign number we will not mis-prefix).
  return null;
}

/** Trim a message to a length that survives being put in a URL. */
export function whatsappMessage(message: string, limit: number = WHATSAPP_MESSAGE_LIMIT): string {
  const text = String(message ?? "").replace(/\s+$/, "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).replace(/\s+$/, "")}…`;
}

/**
 * A `wa.me` deep link carrying `message`.
 *
 * With a resolvable number it opens that contact's chat directly; otherwise it
 * opens WhatsApp and lets the sender choose, which is the safe fallback.
 */
export function whatsappHref(message: string, phone?: string | null): string {
  const text = whatsappMessage(message);
  const number = whatsappNumber(phone);
  const query = text ? `?text=${encodeURIComponent(text)}` : "";
  return number ? `https://wa.me/${number}${query}` : `https://wa.me/${query}`;
}

/** True when a shareable phone number exists, so the UI can label the button. */
export function hasWhatsappNumber(phone: string | null | undefined): boolean {
  return whatsappNumber(phone) !== null;
}
