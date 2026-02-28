#!/usr/bin/env node
/**
 * rate-limiter.js — Token Bucket Rate Limiter
 *
 * In-memory, per-IP rate limiting with automatic cleanup.
 * Zero external dependencies.
 *
 * Algorithm: Token Bucket
 *   - Each IP gets a bucket with `capacity` tokens
 *   - Tokens refill at `refillRate` tokens/second
 *   - Each request consumes 1 token
 *   - When bucket is empty => 429
 *
 * Why Token Bucket over Fixed Window:
 *   - Burst-tolerant: allows short bursts without penalizing legitimate users
 *   - Smooth: no thundering-herd at window boundaries
 *   - Memory-efficient: one entry per active IP
 *
 * Usage:
 *   const rl = require('./rate-limiter');
 *   const limiter = rl.createLimiter({ capacity: 120, refillRate: 2 });
 *   // In request handler:
 *   if (!limiter.consume(clientIP)) {
 *     // 429 Too Many Requests
 *   }
 *   // Cleanup on shutdown:
 *   limiter.destroy();
 */

/**
 * Create a Token Bucket rate limiter.
 *
 * @param {Object} opts
 * @param {number} opts.capacity      - Max tokens per bucket (burst size). Default: 120
 * @param {number} opts.refillRate    - Tokens added per second. Default: 2 (= 120/min)
 * @param {number} opts.sweepInterval - Milliseconds between stale-entry sweeps. Default: 60000
 * @param {number} opts.staleAfter    - Remove entries idle for this many ms. Default: 300000 (5 min)
 * @returns {{ consume, peek, reset, size, destroy }}
 */
function createLimiter(opts = {}) {
  const capacity = opts.capacity || 120;
  const refillRate = opts.refillRate || 2;
  const sweepInterval = opts.sweepInterval || 60000;
  const staleAfter = opts.staleAfter || 300000;

  // Map<string, { tokens: number, lastRefill: number }>
  const buckets = new Map();

  /**
   * Refill tokens for a bucket based on elapsed time.
   * Returns the updated bucket (mutated in place).
   */
  function refill(bucket) {
    const now = Date.now();
    const elapsed = (now - bucket.lastRefill) / 1000; // seconds
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillRate);
    bucket.lastRefill = now;
    return bucket;
  }

  /**
   * Try to consume 1 token for the given key (IP).
   * Returns { allowed, remaining, retryAfter }
   *
   * @param {string} key - Client identifier (usually IP)
   * @returns {{ allowed: boolean, remaining: number, retryAfter: number, limit: number }}
   */
  function consume(key) {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: Date.now() };
      buckets.set(key, bucket);
    }

    refill(bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        retryAfter: 0,
        limit: capacity,
      };
    }

    // Not enough tokens — calculate wait time for 1 token
    const deficit = 1 - bucket.tokens;
    const retryAfter = Math.ceil(deficit / refillRate);

    return {
      allowed: false,
      remaining: 0,
      retryAfter,
      limit: capacity,
    };
  }

  /**
   * Peek at current token count without consuming.
   * @param {string} key
   * @returns {{ remaining: number, limit: number }}
   */
  function peek(key) {
    const bucket = buckets.get(key);
    if (!bucket) return { remaining: capacity, limit: capacity };
    refill(bucket);
    return { remaining: Math.floor(bucket.tokens), limit: capacity };
  }

  /**
   * Reset a specific key's bucket (e.g. after successful auth upgrade).
   * @param {string} key
   */
  function reset(key) {
    buckets.delete(key);
  }

  /**
   * Current number of tracked IPs (for monitoring).
   * @returns {number}
   */
  function size() {
    return buckets.size;
  }

  // Periodic sweep: remove entries that haven't been accessed recently
  const sweepTimer = setInterval(() => {
    const cutoff = Date.now() - staleAfter;
    for (const [key, bucket] of buckets) {
      if (bucket.lastRefill < cutoff) {
        buckets.delete(key);
      }
    }
  }, sweepInterval);

  // Don't block process exit
  if (sweepTimer.unref) sweepTimer.unref();

  /**
   * Cleanup: stop the sweep timer.
   */
  function destroy() {
    clearInterval(sweepTimer);
    buckets.clear();
  }

  return { consume, peek, reset, size, destroy };
}

module.exports = { createLimiter };
