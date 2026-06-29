const { createClient } = require("redis");

let redisClient = null;
let isRedisConnected = false;

// Simple high-performance in-memory cache fallback
const memoryCache = new Map();

// Resolves once Redis either connects or gives up — warmup waits on this
let _redisReadyResolve;
const redisReady = new Promise((resolve) => {
  _redisReadyResolve = resolve;
});

// Helper: clean expired keys from in-memory cache
const cleanExpiredMemoryCache = () => {
  const now = Date.now();
  for (const [key, item] of memoryCache.entries()) {
    if (item.expiry && now > item.expiry) {
      memoryCache.delete(key);
    }
  }
};

// Periodically prune expired memory cache items every 60 seconds
setInterval(cleanExpiredMemoryCache, 60000).unref();

const initRedis = async () => {
  const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  try {
    redisClient = createClient({
      url: redisUrl,
      socket: {
        connectTimeout: 3000,
        reconnectStrategy: (retries) => {
          if (retries >= 3) {
            console.warn("⚠️  Redis unavailable after 3 attempts — using in-memory cache.");
            isRedisConnected = false;
            _redisReadyResolve(); // unblock warmup even on failure
            return false;
          }
          return Math.min(retries * 500, 2000);
        },
      },
    });

    redisClient.on("error", (err) => {
      if (isRedisConnected) {
        console.warn("⚠️  Redis error:", err.message);
        isRedisConnected = false;
      }
    });

    redisClient.on("connect", () => {
      console.log("🚀 Connected to Redis successfully.");
      isRedisConnected = true;
      _redisReadyResolve(); // unblock warmup — Redis is ready
    });

    redisClient.on("end", () => {
      isRedisConnected = false;
    });

    await redisClient.connect();
  } catch (error) {
    console.warn("⚠️  Redis init failed — in-memory cache mode.", error.message);
    isRedisConnected = false;
    redisClient = null;
    _redisReadyResolve(); // unblock warmup
  }
};

// Initialize immediately
initRedis();

const cache = {
  /**
   * Wait until Redis is either connected or confirmed unavailable.
   * Call this before the first cache write in warmupCache.
   */
  waitUntilReady: () => redisReady,

  get: async (key) => {
    try {
      if (isRedisConnected && redisClient) {
        const val = await redisClient.get(key);
        return val ? JSON.parse(val) : null;
      }
    } catch (err) {
      console.error(`Cache Get Error for ${key}:`, err.message);
    }

    // In-memory fallback
    const item = memoryCache.get(key);
    if (!item) return null;
    if (item.expiry && Date.now() > item.expiry) {
      memoryCache.delete(key);
      return null;
    }
    return item.value;
  },

  set: async (key, value, ttlSeconds = 300) => {
    try {
      if (isRedisConnected && redisClient) {
        await redisClient.set(key, JSON.stringify(value), { EX: ttlSeconds });
        return true;
      }
    } catch (err) {
      console.error(`Cache Set Error for ${key}:`, err.message);
    }

    // In-memory fallback
    memoryCache.set(key, {
      value,
      expiry: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
    return true;
  },

  del: async (key) => {
    try {
      if (isRedisConnected && redisClient) {
        await redisClient.del(key);
        return true;
      }
    } catch (err) {
      console.error(`Cache Del Error for ${key}:`, err.message);
    }
    memoryCache.delete(key);
    return true;
  },

  delPattern: async (pattern) => {
    try {
      if (isRedisConnected && redisClient) {
        const keys = await redisClient.keys(pattern);
        if (keys.length > 0) await redisClient.del(keys);
        return true;
      }
    } catch (err) {
      console.error(`Cache DelPattern Error for ${pattern}:`, err.message);
    }

    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
    for (const key of memoryCache.keys()) {
      if (regex.test(key)) memoryCache.delete(key);
    }
    return true;
  },

  isUsingRedis: () => isRedisConnected,
};

module.exports = cache;