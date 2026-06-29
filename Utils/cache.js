const { createClient } = require("redis");

let redisClient = null;
let isRedisConnected = false;

// Simple high-performance in-memory cache fallback
const memoryCache = new Map();

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
setInterval(cleanExpiredMemoryCache, 60000);

const initRedis = async () => {
  const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  try {
    redisClient = createClient({
      url: redisUrl,
      // Attempt connection, fail quickly if server is not running
      socket: {
        connectTimeout: 2000,
        reconnectStrategy: (retries) => {
          if (retries > 3) {
            console.warn("⚠️ Redis connection failed. Falling back to in-memory cache.");
            isRedisConnected = false;
            return false; // Stop retrying
          }
          return Math.min(retries * 500, 2000);
        },
      },
    });

    redisClient.on("error", (err) => {
      // Suppress spamming logs, just update status
      if (isRedisConnected) {
        console.warn("⚠️ Redis client error:", err.message);
        isRedisConnected = false;
      }
    });

    redisClient.on("connect", () => {
      console.log("🚀 Connected to Redis successfully.");
      isRedisConnected = true;
    });

    redisClient.on("end", () => {
      isRedisConnected = false;
    });

    await redisClient.connect();
  } catch (error) {
    console.warn("⚠️ Redis could not be initialized. Operating in in-memory cache mode.", error.message);
    isRedisConnected = false;
    redisClient = null;
  }
};

// Initialize immediately
initRedis();

const cache = {
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
        await redisClient.set(key, JSON.stringify(value), {
          EX: ttlSeconds,
        });
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

    // In-memory fallback
    memoryCache.delete(key);
    return true;
  },

  /**
   * Delete keys matching a pattern (e.g. "tasks:user:*")
   */
  delPattern: async (pattern) => {
    try {
      if (isRedisConnected && redisClient) {
        // Convert glob pattern to redis format if needed
        // For simplicity, we fetch keys matching pattern and delete them
        const keys = await redisClient.keys(pattern);
        if (keys.length > 0) {
          await redisClient.del(keys);
        }
        return true;
      }
    } catch (err) {
      console.error(`Cache DelPattern Error for ${pattern}:`, err.message);
    }

    // In-memory fallback: convert wildcard (*) to regex
    const regexStr = "^" + pattern.replace(/\*/g, ".*") + "$";
    const regex = new RegExp(regexStr);

    for (const key of memoryCache.keys()) {
      if (regex.test(key)) {
        memoryCache.delete(key);
      }
    }
    return true;
  },

  // Helper to check what cache type we are using
  isUsingRedis: () => isRedisConnected,
};

module.exports = cache;
