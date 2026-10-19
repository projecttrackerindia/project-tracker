/** Where people write with any question: billing, sales, security, help. One address everywhere (the website uses the same one). */
export const SUPPORT_EMAIL = 'support@projecttracker.in';
export const supportMailto = (subject?: string) => `mailto:${SUPPORT_EMAIL}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`;
