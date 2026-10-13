# Nuvio AIOMetadata Bridge

This is a deployable, Stremio-protocol metadata/catalog addon for Nuvio. It was generated from:
- `aiometadata-config-2026-06-10-2.json` (latest config; version 2.6.7)
- `aiometadata-config-2026-05-03.json` (older config; version 2.0.0)
- `nuvio-collections-profile-3-2026-05-03.json` (five collections)

## Important limitations

- **No public server URL is created by this ZIP.** Deploy the project first; your host will provide an HTTPS URL. Then install `https://YOUR-HOST/manifest.json` in Nuvio.
- The uploaded exports have no populated API keys. Add your own `MDBLIST_API_KEY` for MDBList list catalogs. Add `TMDB_API_KEY` for TMDB catalogs. Keys are set as hosting environment variables and are not written into the exported config.
- MAL/Jikan catalogs work without a private API key, subject to Jikan's rate limits and the source catalog's mapping.
- This is a metadata/catalog bridge, **not a streaming addon**. It does not scrape or return video streams.
- The bridge does not reproduce all AIOMetadata internals. Full TVDB, Kitsu, Trakt recommendations/watch tracking, poster rating overlays, custom image proxying, AI search, watch-state sync, and all provider-specific behavior are not implemented here. For full metadata coverage, keep the official AIOMetadata addon installed too.
- Nuvio's collection JSON is kept structurally close to your original export. Catalogs referenced only by the profile are included in the bridge manifest even when they were absent from the latest config export.

## Run locally

Requirements: Node.js 18+

```bash
npm install
npm start
```

Open:
- `http://localhost:7000/health`
- `http://localhost:7000/manifest.json`

Optional environment variables:
- `PORT` (default `7000`)
- `MDBLIST_API_KEY` (required for MDBList catalogs)
- `TMDB_API_KEY` (required for TMDB catalogs)
- `CACHE_TTL_SECONDS` (default `3600`)

## Deploy

### Render
1. Push this folder to a GitHub repository.
2. Create a new Web Service in Render from that repository.
3. Runtime: Node; Build command: `npm install`; Start command: `npm start`.
4. Add environment variables `MDBLIST_API_KEY` and/or `TMDB_API_KEY` if you have them.
5. After deploy, test `/health` and `/manifest.json`.
6. In Nuvio, open Settings → Addons → Add Addon and paste `https://YOUR-RENDER-DOMAIN/manifest.json`.

### Docker
```bash
docker build -t nuvio-aiometadata-bridge .
docker run --rm -p 7000:7000 -e MDBLIST_API_KEY=your_key nuvio-aiometadata-bridge
```

## Collections profile

Import `nuvio-collections-profile-updated.json` in Nuvio's collections/profile import screen. Its `addonId` references are updated to `community.nuvio.aiometadata-bridge`, so the server must be deployed and installed first. Keep a backup of the original profile before importing.

## Source mapping

| Source in config | Bridge behavior |
|---|---|
| `mal.*` | Partial Jikan API mapping |
| `mdblist.*` | MDBList list API; needs `MDBLIST_API_KEY` |
| `tmdb.*` | Partial TMDB API mapping; needs `TMDB_API_KEY` |
| `trakt.*`, `anilist.*`, other sources | Declared where present but not fully implemented |

## Security
Never commit API keys to GitHub or include them in the JSON profile. Set them only as environment variables in your hosting provider.
