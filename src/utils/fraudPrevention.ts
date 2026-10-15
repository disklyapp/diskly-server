import { queueConnection } from '../config/redis.js';

// In-memory fallback cache (max 10,000 entries) in case Redis is temporarily disconnected
const memoryViewCooldown = new Map<string, number>();
const memoryLikeCooldown = new Map<string, number>();

function cleanMemoryCache(cache: Map<string, number>, maxAgeMs: number) {
  const now = Date.now();
  if (cache.size > 10000) {
    for (const [key, timestamp] of cache.entries()) {
      if (now - timestamp > maxAgeMs) {
        cache.delete(key);
      }
    }
  }
}

/**
 * Checks if a view from this IP/device is eligible for counting and payout credit.
 * Prevents view count manipulation and payout fraud.
 * Cooldown: 6 hours per (IP + VideoKey)
 */
export async function isViewEligible(ip: string, videoKey: string): Promise<boolean> {
  const cacheKey = `cooldown:view:${ip}:${videoKey}`;
  const cooldownSeconds = 6 * 3600; // 6 hours

  try {
    if (queueConnection && queueConnection.status === 'ready') {
      // Atomic set with NX (only if key does not exist) and EX (expiry)
      const result = await queueConnection.set(cacheKey, '1', 'EX', cooldownSeconds, 'NX');
      return result === 'OK';
    }
  } catch (err) {
    console.warn('Redis unavailable for view cooldown check, using in-memory fallback:', err);
  }

  // Memory fallback
  cleanMemoryCache(memoryViewCooldown, cooldownSeconds * 1000);
  const existing = memoryViewCooldown.get(cacheKey);
  const now = Date.now();
  if (existing && now - existing < cooldownSeconds * 1000) {
    return false;
  }
  memoryViewCooldown.set(cacheKey, now);
  return true;
}

/**
 * Checks if a like from this IP/device is eligible for incrementing.
 * Cooldown: 24 hours per (IP + VideoKey)
 */
export async function isLikeEligible(ip: string, videoKey: string): Promise<boolean> {
  const cacheKey = `cooldown:like:${ip}:${videoKey}`;
  const cooldownSeconds = 24 * 3600; // 24 hours

  try {
    if (queueConnection && queueConnection.status === 'ready') {
      const result = await queueConnection.set(cacheKey, '1', 'EX', cooldownSeconds, 'NX');
      return result === 'OK';
    }
  } catch (err) {
    console.warn('Redis unavailable for like cooldown check, using in-memory fallback:', err);
  }

  // Memory fallback
  cleanMemoryCache(memoryLikeCooldown, cooldownSeconds * 1000);
  const existing = memoryLikeCooldown.get(cacheKey);
  const now = Date.now();
  if (existing && now - existing < cooldownSeconds * 1000) {
    return false;
  }
  memoryLikeCooldown.set(cacheKey, now);
  return true;
}
