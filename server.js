const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const registry = JSON.parse(fs.readFileSync(path.join(__dirname, "data/catalogs.json"), "utf8"));
const allCatalogs = registry.catalogs || [];
const addonId = "community.nuvio.aiometadata-bridge";
const version = require("./package.json").version;
const cache = new Map();
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_SECONDS || 3600) * 1000;
const MDBLIST_API_KEY = process.env.MDBLIST_API_KEY || "";
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const JIKAN_BASE = "https://api.jikan.moe/v4";

function json(res, body) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.json(body);
}
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.time > CACHE_TTL_MS) return null;
  return hit.value;
}
function cacheSet(key, value) {
  cache.set(key, { time: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
}
function stremioType(type) {
  return type === "movie" ? "movie" : "series";
}
function catalogFor(id) {
  return allCatalogs.find(c => c.id === id);
}
function profileDerivedCatalog(id) {
  return allCatalogs.find(c => c.id === id);
}
function toMeta(item, type = "series") {
  const image = item.images?.jpg || item.images?.webp || {};
  const poster = image.large_image_url || image.image_url || item.poster || item.poster_path || null;
  const title = item.title_english || item.title || item.name || "Untitled";
  const genres = (item.genres || []).map(g => typeof g === "string" ? g : g.name).filter(Boolean);
  const year = item.year || (item.aired?.from ? Number(String(item.aired.from).slice(0, 4)) : undefined);
  const meta = {
    id: item.imdb_id || `mal:${item.mal_id || item.id}`,
    type: stremioType(type),
    name: title,
    poster,
    description: item.synopsis || item.overview || "",
    genres,
    releaseInfo: year ? String(year) : undefined,
    imdbRating: item.score ? String(item.score) : undefined,
    runtime: item.duration || undefined,
    links: item.url ? [{ name: "Source", category: "other", url: item.url }] : undefined
  };
  return Object.fromEntries(Object.entries(meta).filter(([,v]) => v !== undefined && v !== null && v !== ""));
}
function toCatalogItem(item, type = "series") {
  const m = toMeta(item, type);
  return { id: m.id, type: m.type, name: m.name, poster: m.poster, description: m.description, releaseInfo: m.releaseInfo, imdbRating: m.imdbRating };
}
async function getJson(url, options = {}) {
  const key = `http:${url}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const response = await fetch(url, { headers: { "User-Agent": "Nuvio-AIOMetadata-Bridge/1.0", ...(options.headers || {}) }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Upstream request failed (${response.status}) for ${new URL(url).hostname}`);
  const data = await response.json();
  cacheSet(key, data);
  return data;
}
function extractMdbListId(catalog) {
  const id = String(catalog.id || "");
  const m = id.match(/^mdblist\.(\d+)$/);
  if (m) return m[1];
  const url = catalog.metadata?.url || "";
  const urlMatch = url.match(/mdblist\.com\/lists\/([^/]+)\/([^/?#]+)/);
  return urlMatch ? `${urlMatch[1]}/${urlMatch[2]}` : null;
}
async function mdblistCatalog(catalog, skip) {
  if (!MDBLIST_API_KEY) {
    const err = new Error("MDBLIST_API_KEY is not configured. Add your own MDBList API key to the hosting environment to enable MDBList catalogs.");
    err.code = "MISSING_MDBLIST_KEY";
    throw err;
  }
  const listId = extractMdbListId(catalog);
  if (!listId) throw new Error("This MDBList catalog has no usable list ID.");
  // MDBList list IDs and public list slugs are both supported by this API route.
  const url = `https://api.mdblist.com/lists/${listId}/items?apikey=${encodeURIComponent(MDBLIST_API_KEY)}&limit=100&offset=${skip}`;
  const data = await getJson(url);
  const items = Array.isArray(data) ? data : (data.items || data.results || []);
  return items.map(x => {
    const m = x.movie || x.show || x;
    return {
      id: m.imdb_id || (m.tmdb_id ? `tmdb:${m.tmdb_id}` : (m.tvdb_id ? `tvdb:${m.tvdb_id}` : `mdblist:${m.id || m.title}`)),
      type: stremioType(catalog.type),
      name: m.title || m.name || "Untitled",
      poster: m.poster || m.poster_path || m.image || undefined,
      description: m.overview || m.plot || undefined,
      releaseInfo: m.year ? String(m.year) : undefined,
      imdbRating: m.score ? String(m.score) : (m.imdb_rating ? String(m.imdb_rating) : undefined)
    };
  }).filter(x => x.id && x.name);
}
async function jikanCatalog(catalog, skip) {
  const id = catalog.id || "";
  const metadata = catalog.metadata || {};
  const discover = metadata.discover || {};
  const params = new URLSearchParams({ limit: "25", page: String(Math.floor(skip / 25) + 1), sfw: "true" });
  let endpoint = "/top/anime";
  if (id === "mal.airing") endpoint = "/seasons/now";
  else if (id === "mal.upcoming") endpoint = "/seasons/upcoming";
  else if (id === "mal.seasons") endpoint = "/seasons/now";
  else if (id === "mal.schedule") endpoint = "/schedules";
  else if (id === "mal.top_movies") { endpoint = "/top/anime"; params.set("type", "movie"); }
  else if (id === "mal.top_series") { endpoint = "/top/anime"; params.set("type", "tv"); }
  else if (id === "mal.most_favorites") { endpoint = "/top/anime"; params.set("filter", "favorite"); }
  else if (id === "mal.most_popular") { endpoint = "/top/anime"; params.set("filter", "bypopularity"); }
  else if (id === "mal.top_anime") endpoint = "/top/anime";
  else if (id.includes("discover") && discover.params) {
    const p = discover.params;
    endpoint = "/anime";
    if (p.start_date) params.set("start_date", p.start_date);
    if (p.end_date) params.set("end_date", p.end_date);
    if (p.order_by) params.set("order_by", p.order_by);
    if (p.sort) params.set("sort", p.sort);
    if (p.min_score) params.set("min_score", String(p.min_score));
    if (p.max_score) params.set("max_score", String(p.max_score));
    if (p.type) params.set("type", String(p.type));
  } else if (/decade/i.test(catalog.name || "") || /80sDecade|90sDecade|00sDecade|10sDecade|20sDecade/.test(id)) {
    endpoint = "/anime";
    const yearMatch = String(catalog.name).match(/(1960|1970|1980|1990|2000|2010|2020)/);
    if (yearMatch) {
      const y = Number(yearMatch[1]);
      params.set("start_date", `${y}-01-01`);
      params.set("end_date", `${y + 9}-12-31`);
      params.set("order_by", "score"); params.set("sort", "desc");
    }
  } else {
    endpoint = "/top/anime";
  }
  const data = await getJson(`${JIKAN_BASE}${endpoint}?${params.toString()}`);
  return (data.data || []).map(x => toCatalogItem(x, catalog.type));
}
async function tmdbCatalog(catalog, skip) {
  if (!TMDB_API_KEY) {
    const err = new Error("TMDB_API_KEY is not configured. TMDB-backed catalogs need your own TMDB API key.");
    err.code = "MISSING_TMDB_KEY";
    throw err;
  }
  const endpoint = catalog.id === "tmdb.top" ? "/movie/popular" : "/trending/all/week";
  const url = `https://api.themoviedb.org/3${endpoint}?api_key=${encodeURIComponent(TMDB_API_KEY)}&page=${Math.floor(skip / 20) + 1}&include_adult=false`;
  const data = await getJson(url);
  return (data.results || []).map(x => ({
    id: x.imdb_id || (x.media_type === "tv" ? `tmdb:${x.id}` : `tmdb:${x.id}`),
    type: x.media_type === "tv" || catalog.type === "series" ? "series" : "movie",
    name: x.title || x.name,
    poster: x.poster_path ? `https://image.tmdb.org/t/p/w500${x.poster_path}` : undefined,
    description: x.overview,
    releaseInfo: String((x.release_date || x.first_air_date || "").slice(0,4) || ""),
    imdbRating: x.vote_average ? String(x.vote_average) : undefined
  })).filter(x => x.name);
}
app.get("/", (_req, res) => res.type("text").send("Nuvio AIOMetadata Bridge is running. See /manifest.json and /health."));
app.get("/health", (_req, res) => json(res, {
  ok: true, addonId, version,
  catalogCount: allCatalogs.length,
  configured: { mdblist: Boolean(MDBLIST_API_KEY), tmdb: Boolean(TMDB_API_KEY), jikan: true },
  note: "This is a metadata/catalog bridge. It does not provide video streams."
}));
app.get("/manifest.json", (_req, res) => {
  const seen = new Set();
  const manifestCatalogs = allCatalogs
    .filter(c => c && c.id && c.enabled !== false)
    .map(c => {
      const type = stremioType(c.type);
      const id = c.id;
      const key = `${type}:${id}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return { type, id, name: c.name || id };
    }).filter(Boolean);
  json(res, {
    id: addonId,
    version,
    name: "Nuvio AIOMetadata Bridge",
    description: "Catalog and metadata bridge built from your exported AIOMetadata configuration and Nuvio collections profile. No streams are provided.",
    logo: "https://raw.githubusercontent.com/Stremio/stremio-branding/master/stremio-logo-small.png",
    resources: ["catalog", "meta"],
    types: ["movie", "series"],
    idPrefixes: ["tt", "mal:", "tmdb:", "tvdb:", "mdblist:"],
    catalogs: manifestCatalogs,
    behaviorHints: { configurable: true, configurationRequired: false }
  });
});
app.get("/catalog/:type/:id.json", async (req, res) => {
  const catalog = catalogFor(req.params.id);
  if (!catalog) return json(res.status(404), { metas: [], error: "Unknown catalog ID", id: req.params.id });
  const type = req.params.type;
  if (!["movie", "series"].includes(type)) return json(res.status(400), { metas: [], error: "Unsupported content type" });
  const skip = Math.max(0, Math.min(1000, Number.parseInt(req.query.skip || "0", 10) || 0));
  const cacheKey = `catalog:${type}:${catalog.id}:${skip}`;
  const cached = cacheGet(cacheKey);
  if (cached) return json(res, cached);
  try {
    let metas;
    if (catalog.source === "mdblist" || catalog.id.startsWith("mdblist.")) metas = await mdblistCatalog(catalog, skip);
    else if (catalog.source === "tmdb" || catalog.id.startsWith("tmdb.")) metas = await tmdbCatalog(catalog, skip);
    else if (catalog.source === "mal" || catalog.id.startsWith("mal.")) metas = await jikanCatalog(catalog, skip);
    else metas = [];
    const body = { metas };
    cacheSet(cacheKey, body);
    return json(res, body);
  } catch (e) {
    const status = e.code && e.code.startsWith("MISSING_") ? 503 : 502;
    return json(res.status(status), { metas: [], error: e.message, catalogId: catalog.id });
  }
});
app.get("/meta/:type/:id.json", async (req, res) => {
  const id = req.params.id;
  try {
    if (id.startsWith("mal:")) {
      const malId = id.slice(4).split(":")[0];
      const data = await getJson(`${JIKAN_BASE}/anime/${encodeURIComponent(malId)}/full`);
      return json(res, { meta: toMeta(data.data || {}, "series") });
    }
    if (id.startsWith("tmdb:") && TMDB_API_KEY) {
      const tmdbId = id.slice(5);
      const data = await getJson(`https://api.themoviedb.org/3/${req.params.type === "movie" ? "movie" : "tv"}/${encodeURIComponent(tmdbId)}?api_key=${encodeURIComponent(TMDB_API_KEY)}`);
      const meta = {
        id, type: req.params.type, name: data.title || data.name,
        poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : undefined,
        background: data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : undefined,
        description: data.overview, releaseInfo: String((data.release_date || data.first_air_date || "").slice(0,4) || ""),
        genres: (data.genres || []).map(g => g.name), imdbRating: data.vote_average ? String(data.vote_average) : undefined
      };
      return json(res, { meta: Object.fromEntries(Object.entries(meta).filter(([,v]) => v !== undefined)) });
    }
    return json(res.status(404), { meta: null, error: "Metadata lookup for this ID is not available in this bridge. Install AIOMetadata itself for full TMDB/TVDB/Kitsu metadata." });
  } catch (e) {
    return json(res.status(502), { meta: null, error: e.message });
  }
});
app.listen(process.env.PORT || 7000, "0.0.0.0", () => {
  console.log(`Nuvio AIOMetadata Bridge listening on port ${process.env.PORT || 7000}`);
});
