const espoClient = require("../Utils/espoClient");
const cache = require("../Utils/cache");

const CACHE_TTL = 600; // 10 minutes

// ─── Fetch all users (sequential pagination until exhausted) ─────────────────
const fetchAllUsers = async () => {
  const PAGE = 200;
  let offset = 0;
  let collected = [];

  while (true) {
    const response = await espoClient.get("/User", {
      params: { maxSize: PAGE, offset, select: "id,name" },
    });
    const page = response.data?.list || [];
    const total = response.data?.total ?? page.length;
    collected = collected.concat(page);
    offset += page.length;
    if (offset >= total || page.length === 0) break;
  }

  return collected;
};

// ─── GET /api/users ──────────────────────────────────────────────────────────
// Supports two modes:
//   1. ?page=&limit=  → CRM-level pagination (fast, no full fetch)
//   2. No query params → full cached list
const getAllUsers = async (req, res) => {
  try {
    const { page, limit } = req.query;
    const isPaginated = page || limit;

    // ── Mode 1: Paginated — fetch only the requested page from CRM ──
    if (isPaginated) {
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 20));
      const offset = (pageNum - 1) * limitNum;

      const cacheKey = `users:page:${pageNum}:${limitNum}`;
      let cached = await cache.get(cacheKey);

      if (!cached) {
        const response = await espoClient.get("/User", {
          params: { maxSize: limitNum, offset, select: "id,name" },
        });
        const list = response.data?.list || [];
        const total = response.data?.total ?? 0;
        const users = list.map(({ id, name }) => ({ id, name }));

        cached = { users, total, totalPages: Math.ceil(total / limitNum) };
        await cache.set(cacheKey, cached, CACHE_TTL);
      }

      return res.status(200).json({
        success: true,
        page: pageNum,
        limit: limitNum,
        total: cached.total,
        totalPages: cached.totalPages,
        data: cached.users,
      });
    }

    // ── Mode 2: Full list (cached) ──
    const cacheKey = "users:all";
    let users = await cache.get(cacheKey);

    if (!users) {
      console.log("Cache miss. Fetching all users from CRM...");
      const all = await fetchAllUsers();
      users = all.map(({ id, name }) => ({ id, name }));
      await cache.set(cacheKey, users, CACHE_TTL);
    }

    return res.status(200).json({
      success: true,
      total: users.length,
      data: users,
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const message = error.response?.data?.message || error.message;
    return res.status(status).json({
      success: false,
      message: "Failed to fetch users",
      error: message,
    });
  }
};

module.exports = { getAllUsers, fetchAllUsers };