/** Lightweight input validators, kept dependency-free for unit testing. */

/**
 * Basic email shape check: non-empty local part, "@", domain, and a dotted TLD,
 * with no whitespace. Intentionally permissive — server-side validation is the
 * source of truth.
 */
export const isEmailValid = (email: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
