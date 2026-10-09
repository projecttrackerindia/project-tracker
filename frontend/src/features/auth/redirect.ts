/** Only internal paths may be carried across registration, verification and sign-in. */
export const safeRedirect = (path: string | null) =>
  path && path.length <= 2048 && path.startsWith('/') && !path.startsWith('//')
    && !path.includes('\\') && ![...path].some((c) => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159))
    && !path.includes('://') ? path : '/';
