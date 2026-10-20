import * as meet from './meet.mjs';
import * as teams from './teams.mjs';

/** Hosts of Microsoft Teams meeting links (work or school, personal, and the newer cloud.microsoft address). */
export const TEAMS_HOSTS = ['teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft'];
export const DEFAULT_HOSTS = ['meet.google.com', ...TEAMS_HOSTS];

/**
 * Which meeting service a link is for, so the bot drives the right page: Microsoft Teams by its host (or a Teams join path, which is also how
 * the tests point at their synthetic Teams page), Google Meet otherwise.
 */
export function platformFor(url) {
  try {
    const u = new URL(url);
    if (TEAMS_HOSTS.includes(u.hostname) || u.pathname.startsWith('/l/meetup-join/') || u.pathname.startsWith('/meet/') && u.searchParams.has('p')) return teams;
  } catch { /* not a URL: the default */ }
  return meet;
}
