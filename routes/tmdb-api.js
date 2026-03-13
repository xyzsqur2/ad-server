import express from 'express';
import { getCacheKey, wrap } from '../cache/cacheManager.js';
import {
  getMovieDetails,
  getTvDetails,
  searchMovie,
  searchTv,
  getPopularMovies,
  getPopularTv,
  getTrendingMovies,
  getTrendingTv
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

router.get('/movie/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    const key = getCacheKey('movie', id);
    const data = await wrap(key, () => getMovieDetails(id));
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'TMDb request failed', details: e?.message });
  }
});

router.get('/tv/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    const key = getCacheKey('tv', id);
    const data = await wrap(key, () => getTvDetails(id));
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'TMDb request failed', details: e?.message });
  }
});

router.get('/search/movie', async (req, res) => {
  const q = normalizeQuery(req.query.q);
  const page = normalizePage(req.query.page);
  if (!q) return res.status(400).json({ error: 'Missing query param: q' });

  try {
    const key = getCacheKey('search_movie', q, 'page', String(page));
    const data = await wrap(key, () => searchMovie(q, page));
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'TMDb request failed', details: e?.message });
  }
});

router.get('/search/tv', async (req, res) => {
  const q = normalizeQuery(req.query.q);
  const page = normalizePage(req.query.page);
  if (!q) return res.status(400).json({ error: 'Missing query param: q' });

  try {
    const key = getCacheKey('search_tv', q, 'page', String(page));
    const data = await wrap(key, () => searchTv(q, page));
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

export { router };

