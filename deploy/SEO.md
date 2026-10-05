# Being found on Google and Bing

The site builds its own search pages (see `frontend/site/`): the home page, Features (and four detail pages), Pricing, Security, `sitemap.xml`
and `robots.txt`, with titles, descriptions, social previews, structured data and the logo. Everything below is the part only the site's owner
can do, because it needs a Google or Microsoft account and proof that the domain is yours.

## 1. Google Search Console (about 10 minutes)

1. Open <https://search.google.com/search-console> and sign in with the account that should own this.
2. **Add property** → **Domain** → enter your domain (for example `projecttracker.in`). Google shows a TXT record; add it at your DNS provider
   and press **Verify**. (If you cannot edit DNS, choose **URL prefix** instead, enter `https://your-domain/`, pick **HTML tag**, copy the
   token from `content="..."` into `GOOGLE_SITE_VERIFICATION` in `.env`, rebuild and deploy, then press **Verify**.)
3. **Sitemaps** → enter `sitemap.xml` → **Submit**. It should say *Success*.
4. **URL inspection** → paste each of `/`, `/features/`, `/pricing/`, `/security/` → **Request indexing**.
5. Come back in a few days: **Pages** shows what is indexed, **Enhancements** shows the structured data Google found.

## 2. Bing and others (5 minutes)

- <https://www.bing.com/webmasters> → **Import from Google Search Console** is the quickest. Or add the site and put the token in
  `BING_SITE_VERIFICATION`.
- **IndexNow** tells Bing, Yandex and others about changes at once: make up a key of 16-64 letters and digits, set `INDEXNOW_KEY` in `.env`,
  rebuild (the build writes `/<key>.txt`), then after each deploy run `INDEXNOW_KEY=<key> SITE_URL=https://your-domain node frontend/site/indexnow.mjs`.

## 3. What to expect

Google does not change a result the moment you submit it: a new title, description and logo usually appear within days to a few weeks. The
extra links under the main result ("sitelinks") are chosen by Google alone, and appear only for sites it considers established.
The logo in results is the favicon: Google requires it to be a multiple of 48 px and crawlable, both done (`/favicon.ico`, `/favicon-48x48.png`).
`www.` is not redirected for you: if you use it, point it at the main domain at your DNS or hosting provider.

## 4. Changing the words or the pages

Edit `frontend/site/content.ts` (the words) and rebuild. `SITE_URL` is set from `DOMAIN` by `deploy/docker-compose.prod.yml`, so canonical links,
the sitemap and social previews always name the real address. Only the public screens are indexable; the app itself, reset links and any unknown
address are marked `noindex`.
