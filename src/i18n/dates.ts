// Localized dates (Story 1.5). Pure module so Vitest can test it.
import type { Locale } from '../content/schemas.ts';

const DATE_LOCALES: Record<Locale, string> = { id: 'id-ID', en: 'en-GB' };

/** `2026-03-12` → "12 Maret 2026" (id) / "12 March 2026" (en). Input is an ISO `YYYY-MM-DD` date. */
export function formatDate(isoDate: string, lang: Locale): string {
  return new Intl.DateTimeFormat(DATE_LOCALES[lang], {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${isoDate}T00:00:00Z`));
}
