// Tells IndexNow search engines (Bing, Yandex ...) which public pages changed. Run after a deploy:
//   INDEXNOW_KEY=<key> SITE_URL=https://your-domain node frontend/site/indexnow.mjs
const key = process.env.INDEXNOW_KEY;
const site = (process.env.SITE_URL || '').replace(/\/$/, '');
if (!key || !site) { console.error('Set INDEXNOW_KEY and SITE_URL.'); process.exit(1); }
const sitemap = await (await fetch(`${site}/sitemap.xml`)).text();
const urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: new URL(site).host, key, keyLocation: `${site}/${key}.txt`, urlList }),
});
console.log(`${res.status} ${res.statusText}: ${urlList.length} address(es) sent`);
