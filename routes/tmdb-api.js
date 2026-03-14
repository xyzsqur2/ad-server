import express from 'express';
import { getCacheKey, wrap } from '../cache/cacheManager.js';
import {
  getMovieDetails,
  getTvDetails,
  getTvSeasonDetails,
  searchMovie,
  searchTv,
  searchMulti,
  getPopularMovies,
  getPopularTv,
  getTrendingMovies,
  getTrendingTv,
  getTrending,
  getUpcomingMovies,
  getAiringTodayTv,
  discoverMovie,
  discoverTv
} from '../services/tmdbService.js';

const router = express.Router();

function normalizePage(page) {
  const p = Number(page || 1);
  if (!Number.isFinite(p) || p <= 0) return 1;
  return Math.floor(p);
}

function normalizeQuery(q) {
  return String(q || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function pickQuery(req, ...keys) {
  for (const k of keys) {
    const v = req.query?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

function serializeParams(params) {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => [String(k), String(v).trim()]);

  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return entries.map(([k, v]) => `${k}=${v}`).join('&');
}

router.get('/tv/:tvId/season/:seasonNumber', async (req, res) => {
  try {
    const tvId = String(req.params.tvId);
    const seasonNumber = String(req.params.seasonNumber);
    const key = getCacheKey('tv_season', tvId, 'season', seasonNumber);
    const data = await wrap(key, () => getTvSeasonDetails(tvId, seasonNumber));
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'TMDb request failed', details: e?.message });
  }
});

router.get('/search/movie', async (req, res) => {
  const raw = pickQuery(req, 'query', 'q');
  const q = normalizeQuery(raw);
  const page = normalizePage(req.query.page);
  if (!q) return res.status(400).json({ error: 'Missing query param: query' });

  try {
    const key = getCacheKey('search_movie', q, 'page', String(page));
    const data = await wrap(key, () => searchMovie(q, page));
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'TMDb request failed', details: e?.message });
  }
});

router.get('/search/tv', async (req, res) => {
  const raw = pickQuery(req, 'query', 'q');
  const q = normalizeQuery(raw);
  const page = normalizePage(req.query.page);
  if (!q) return res.status(400).json({ error: 'Missing query param: query' });

  try {
    const key = getCacheKey('search_tv', q, 'page', String(page));
    const data = await wrap(key, () => searchTv(q, page));
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'TMDb request failed', details: e?.message });
  }
});

router.get('/search/multi', async (req, res) => {
  const raw = pickQuery(req, 'query', 'q');
  const q = normalizeQuery(raw);
  const page = normalizePage(req.query.page);
  if (!q) return res.status(400).json({ error: 'Missing query param: query' });

  try {
    const key = getCacheKey('search_multi', q, 'page', String(page));
    const data = await wrap(key, () => searchMulti(q, page));
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'TMDb request failed', details: e?.message });
  }
});

router.get('/movies/popular', async (req, res) => {
  const page = normalizePage(req.query.page);
  try {
    const key = getCacheKey('popular_movies', 'page', String(page));
    const data = await wrap(key, () => getPopularMovies(page));
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'TMDb request failed', details: e?.message });
  }
});

router.get('/movie/popular', async (req, res) => {
  const page = normalizePage(req.query.page);
  try {
    const key = getCacheKey('popular_movies', 'page', String(page));
    const data = await wrap(key, () => getPopularMovies(page));
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'TMDb request failed', details: e?.message });
  }
});

router.get('/movie/upcoming', async (req, res) => {
  const page = normalizePage(req.query.page);
  try {
    const key = getCacheKey('upcoming_movies', 'page', String(page));
    const data = await wrap(key, () => getUpcomingMovies(page));
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'TMDb request failed', details: e?.message });
  }
});

router.get('/tv/popular', async (req, res) => {
  const page = normalizePage(req.query.page);
  try {
    const key = getCacheKey('popular_tv', 'page', String(page));
    const data = await wrap(key, () => getPopularTv(page));
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'TMDb request failed', details: e?.message });
  }
});

router.get('/movies/trending', async (req, res) => {
  const page = normalizePage(req.query.page);
  try {
    const key = getCacheKey('trending_movie_week', 'page', String(page));
    const data = await wrap(key, () => getTrendingMovies(page));
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'TMDb request failed', details: e?.message });
  }
});

router.get('/tv/trending', async (req, res) => {
  const page = normalizePage(req.query.page);
  try {
    const key = getCacheKey('trending_tv_week', 'page', String(page));
    const data = await wrap(key, () => getTrendingTv(page));
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'TMDb request failed', details: e?.message });
  }
});

router.get('/trending/:mediaType/:timeWindow', async (req, res) => {
  const page = normalizePage(req.query.page);
  const mediaType = String(req.params.mediaType);
  const timeWindow = String(req.params.timeWindow);

  try {
    const key = getCacheKey('trending', mediaType, timeWindow, 'page', String(page));
    const data = await wrap(key, () => getTrending(mediaType, timeWindow, page));
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'TMDb request failed', details: e?.message });
  }
});

router.get('/tv/airing_today', async (req, res) => {
  const page = normalizePage(req.query.page);
  try {
    const key = getCacheKey('airing_today_tv', 'page', String(page));
    const data = await wrap(key, () => getAiringTodayTv(page));
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'TMDb request failed', details: e?.message });
  }
});

router.get('/discover/movie', async (req, res) => {
  const page = normalizePage(req.query.page);
  const params = {
    page,
    with_genres: req.query.with_genres,
    sort_by: req.query.sort_by,
    include_adult: req.query.include_adult,
    language: req.query.language
  };

  try {
    const key = getCacheKey('discover_movie', serializeParams(params));
    const data = await wrap(key, () => discoverMovie(params));
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'TMDb request failed', details: e?.message });
  }
});

router.get('/discover/tv', async (req, res) => {
  const page = normalizePage(req.query.page);
  const params = {
    page,
    with_genres: req.query.with_genres,
    with_original_language: req.query.with_original_language,
    sort_by: req.query.sort_by,
    include_adult: req.query.include_adult,
    language: req.query.language
  };

  try {
    const key = getCacheKey('discover_tv', serializeParams(params));
    const data = await wrap(key, () => discoverTv(params));
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'TMDb request failed', details: e?.message });
  }
});

router.get('/movie/:id(\\d+)', async (req, res) => {
  try {
    const id = String(req.params.id);
    const key = getCacheKey('movie', id);
    const data = await wrap(key, () => getMovieDetails(id));
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'TMDb request failed', details: e?.message });
  }
});

router.get('/tv/:id(\\d+)', async (req, res) => {
  try {
    const id = String(req.params.id);
    const key = getCacheKey('tv', id);
    const data = await wrap(key, () => getTvDetails(id));
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'TMDb request failed', details: e?.message });
  }
});

export { router };
