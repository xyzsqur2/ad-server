import { getCacheKey, set } from '../cache/cacheManager.js';
import { getPopularMovies, getPopularTv, getTrendingMovies, getTrendingTv } from '../services/tmdbService.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

class PrecacheJob {
  constructor() {
    this.isRunning = false;
    this._interval = null;
  }

  start() {
    if (this.isRunning) {
      console.log('⚠️ Precache job já está rodando');
      return;
    }

    this.run().catch((e) => {
      console.error('[PRECACHE_UPDATE] failed', e?.message || e);
    });

    this._interval = setInterval(() => {
      this.run().catch((e) => {
        console.error('[PRECACHE_UPDATE] failed', e?.message || e);
      });
    }, SIX_HOURS_MS);

    this.isRunning = true;
    console.log('✅ Precache job iniciado (executa a cada 6 horas)');
  }

  async run() {
    console.log('[PRECACHE_UPDATE] started');

    await Promise.all([
      this.update(getCacheKey('popular_movies', 'page', '1'), () => getPopularMovies(1)),
      this.update(getCacheKey('trending_movie_week', 'page', '1'), () => getTrendingMovies(1)),
      this.update(getCacheKey('popular_tv', 'page', '1'), () => getPopularTv(1)),
      this.update(getCacheKey('trending_tv_week', 'page', '1'), () => getTrendingTv(1))
    ]);

    console.log('[PRECACHE_UPDATE] finished');
  }

  async update(key, fetchFn) {
    try {
      const data = await fetchFn();
      set(key, data);
      console.log(`[PRECACHE_UPDATE] ok key=${key}`);
    } catch (e) {
      console.error(`[PRECACHE_UPDATE] failed key=${key} error=${e?.message || e}`);
    }
  }
}

const precacheJob = new PrecacheJob();

export default precacheJob;

