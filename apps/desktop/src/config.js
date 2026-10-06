'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** Where the app lives. A build can bake in another address (a company's own server) by putting config.json next to the program; otherwise this is used. */
const DEFAULT_URL = 'https://projecttracker.in';

function readConfig(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')); } catch { return {}; }
}

/** The address of the app, read once at start: the PT_APP_URL variable, then config.json, then the default. Only http(s) addresses are accepted. */
function appUrl(env = process.env, dir = process.resourcesPath || __dirname) {
  const candidate = env.PT_APP_URL || readConfig(dir).url || DEFAULT_URL;
  try {
    const u = new URL(candidate);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) return u.origin;
  } catch { /* fall through */ }
  return DEFAULT_URL;
}

/** Where releases are published, for the "a new version is available" notice. */
const RELEASES_API = 'https://api.github.com/repos/projecttrackerindia/project-tracker/releases/latest';
const DOWNLOAD_PAGE = 'https://projecttracker.in/download/';

module.exports = { appUrl, DEFAULT_URL, RELEASES_API, DOWNLOAD_PAGE };
