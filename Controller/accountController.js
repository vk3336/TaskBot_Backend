const espoClient = require("../Utils/espoClient");
const cache = require("../Utils/cache");

const fetchAllAccounts = async () => {
  const PAGE = 200;
  
  // Fetch first page to get total count
  const firstResponse = await espoClient.get("/Account", {
    params: { maxSize: PAGE, offset: 0 },
  });
  
  const firstPage = firstResponse.data?.list || [];
  const total = firstResponse.data?.total ?? firstPage.length;
  
  if (total <= PAGE) {
    return firstPage;
  }
  
  // Batch requests to limit concurrency and avoid socket exhaustion
  const CONCURRENCY = 5;
  const offsets = [];
  for (let offset = PAGE; offset < total; offset += PAGE) {
    offsets.push(offset);
  }
  
  let collected = firstPage;
  for (let i = 0; i < offsets.length; i += CONCURRENCY) {
    const batch = offsets.slice(i, i + CONCURRENCY);
    const promises = batch.map((offset) =>
      espoClient.get("/Account", {
        params: { maxSize: PAGE, offset },
      })
    );
    const responses = await Promise.all(promises);
    for (const res of responses) {
      const page = res.data?.list || [];
      collected = collected.concat(page);
    }
  }
  
  return collected;
};

// Helper to paginate an array
const paginateArray = (array, page, limit) => {
  const pageNum = parseInt(page, 10) || 1;
  const limitNum = parseInt(limit, 10) || 20;
  const offset = (pageNum - 1) * limitNum;
  
  const paginatedItems = array.slice(offset, offset + limitNum);
  const totalPages = Math.ceil(array.length / limitNum);

  return {
    page: pageNum,
    limit: limitNum,
    totalPages,
    total: array.length,
    data: paginatedItems,
  };
};

// GET /api/accounts — fetch all accounts (id + name only)
const getAllAccounts = async (req, res) => {
  try {
    const cacheKey = "accounts:all";
    let accounts = await cache.get(cacheKey);

    if (!accounts) {
      console.log("Cache miss. Fetching all accounts from CRM (Batch-Parallel)...");
      const fetchedAccounts = await fetchAllAccounts();

      accounts = fetchedAccounts.map((account) => ({
        id: account.id,
        name: account.name,
      }));

      // Cache the accounts list for 10 minutes (600 seconds)
      await cache.set(cacheKey, accounts, 600);
    }

    const { page, limit } = req.query;
    if (page || limit) {
      const paginatedResult = paginateArray(accounts, page, limit);
      return res.status(200).json({
        success: true,
        ...paginatedResult,
        cached: true,
      });
    }

    return res.status(200).json({
      success: true,
      total: accounts.length,
      data: accounts,
      cached: true,
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const message = error.response?.data?.message || error.message;
    return res.status(status).json({
      success: false,
      message: "Failed to fetch accounts",
      error: message,
    });
  }
};

module.exports = { getAllAccounts };
