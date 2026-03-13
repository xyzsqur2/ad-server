const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const store = new Map();
const inFlight = new Map();

function now() {
  return Date.now();
}

function isExpired(entry, t = now()) {
  return !entry || typeof entry.expiresAt !== 'number' || entry.expiresAt <= t;
}

export function getCacheKey(...parts) {
  return parts.filter(Boolean).join(':');
}

export function get(key) {
  const entry = store.get(key);
  if (!entry) {
    console.log(`[CACHE_MISS] key=${key}`);
    return { hit: false };
  }

  if (isExpired(entry)) {
    store.delete(key);
    console.log(`[CACHE_MISS] key=${key}`);
    return { hit: false };
  }

  console.log(`[CACHE_HIT] key=${key}`);
  return { hit: true, value: entry.value };
}

export function set(key, value, ttlMs = DEFAULT_TTL_MS) {
  store.set(key, { value, expiresAt: now() + ttlMs });
}

export async function wrap(key, fetchFn, ttlMs = DEFAULT_TTL_MS) {
  const cached = get(key);
  if (cached.hit) return cached.value;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const p = (async () => {
    try {
      const value = await fetchFn();
      set(key, value, ttlMs);
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, p);
  return p;
}

