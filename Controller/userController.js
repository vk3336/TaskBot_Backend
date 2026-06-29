const espoClient = require("../Utils/espoClient");
const cache = require("../Utils/cache");

// Fix #3: paginate until all users are fetched — no silent 200-record cap
const fetchAllUsers = async () => {
  const PAGE = 200;
  let offset = 0;
  let collected = [];

  while (true) {
    const response = await espoClient.get("/User", {
      params: { maxSize: PAGE, offset },
    });
    const page = response.data?.list || [];
    const total = response.data?.total ?? page.length;
    collected = collected.concat(page);
    offset += page.length;
    if (offset >= total || page.length === 0) break;
  }

  return collected;
};

// GET /api/users — fetch all users (id + name only)
const getAllUsers = async (_req, res) => {
  try {
    const cacheKey = "users:all";
    const cachedUsers = await cache.get(cacheKey);

    if (cachedUsers) {
      return res.status(200).json({
        success: true,
        total: cachedUsers.length,
        data: cachedUsers,
        cached: true,
      });
    }

    const users = await fetchAllUsers();

    const result = users.map((user) => ({
      id: user.id,
      name: user.name,
    }));

    // Cache the users list for 10 minutes (600 seconds)
    await cache.set(cacheKey, result, 600);

    return res.status(200).json({
      success: true,
      total: result.length,
      data: result,
      cached: false,
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

module.exports = { getAllUsers };
