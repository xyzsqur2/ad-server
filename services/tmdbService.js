const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const DEFAULT_LANGUAGE = 'pt-BR';

function requireApiKey() {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw new Error('TMDB_API_KEY is not set');
  return key;
}

function normalizePage(page) {
  const p = Number(page || 1);
  if (!Number.isFinite(p) || p <= 0) return 1;
  return Math.floor(p);
}

function buildUrl(path, params = {}) {
  const apiKey = requireApiKey();
  const url = new URL(`${TMDB_BASE_URL}${path}`);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('language', params.language || DEFAULT_LANGUAGE);

  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    if (k === 'language') return;
    url.searchParams.set(k, String(v));
  });

  return url.toString();
}

async function requestJson(path, params = {}) {
  const page = params.page ? normalizePage(params.page) : undefined;
  const finalParams = page ? { ...params, page } : params;

  const url = buildUrl(path, finalParams);
  console.log(`[TMDB_REQUEST] path=${path}${page ? ` page=${page}` : ''}`);

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`TMDb API error: ${res.status}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return res.json();
}

export async function getMovieDetails(id) {
  return requestJson(`/movie/${id}`);
}

export async function getTvDetails(id) {
  return requestJson(`/tv/${id}`);
}

export async function searchMovie(query, page = 1) {
  return requestJson('/search/movie', { query, include_adult: false, page });
}

export async function searchTv(query, page = 1) {
  return requestJson('/search/tv', { query, include_adult: false, page });
}

export async function getPopularMovies(page = 1) {
  return requestJson('/movie/popular', { page });
}

export async function getPopularTv(page = 1) {
  return requestJson('/tv/popular', { page });
}

export async function getTrendingMovies(page = 1) {
  return requestJson('/trending/movie/week', { page });
}

export async function getTrendingTv(page = 1) {
  return requestJson('/trending/tv/week', { page });
}

