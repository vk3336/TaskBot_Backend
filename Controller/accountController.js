const espoClient = require("../Utils/espoClient");
const cache = require("../Utils/cache");

const PAGE_SIZE = 200;
const CACHE_TTL = 600; // 10 minutes

// ─── Fetch a single page from EspoCRM ────────────────────────────────────────
const fetchAccountPage = async (offset, limit) => {
  const response = await espoClient.get("/Account", {
    params: { maxSize: limit, offset, select: "id,name" },
  });
  return {
    list: response.data?.list || [],
    total: response.data?.total ?? 0,
  };
};

// ─── Fetch ALL accounts (batch-parallel) — used by warmup ────────────────────
const fetchAllAccounts = async () => {
  const { list: firstPage, total } = await fetchAccountPage(0, PAGE_SIZE);
  if (total <= PAGE_SIZE) return firstPage;

  const CONCURRENCY = 5;
  const offsets = [];
  for (let off = PAGE_SIZE; off < total; off += PAGE_SIZE) offsets.push(off);

  let all = [...firstPage];
  for (let i = 0; i < offsets.length; i += CONCURRENCY) {
    const batch = offsets.slice(i, i + CONCURRENCY);
    const pages = await Promise.all(batch.map((off) => fetchAccountPage(off, PAGE_SIZE)));
    for (const { list } of pages) all = all.concat(list);
  }
  return all;
};

// ─── GET /api/accounts ───────────────────────────────────────────────────────
const getAllAccounts = async (req, res) => {
  try {
    const { page, limit } = req.query;
    const isPaginated = page || limit;

    if (isPaginated) {
      const pageNum  = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 20));
      const offset   = (pageNum - 1) * limitNum;

      const cacheKey = `accounts:page:${pageNum}:${limitNum}`;
      let cached = await cache.get(cacheKey);

      if (!cached) {
        console.log(`Cache miss. Fetching accounts page ${pageNum} from CRM...`);
        const { list, total } = await fetchAccountPage(offset, limitNum);
        const accounts = list.map(({ id, name }) => ({ id, name }));
        cached = { accounts, total, totalPages: Math.ceil(total / limitNum) };
        await cache.set(cacheKey, cached, CACHE_TTL);
      }

      return res.status(200).json({
        success: true,
        page: pageNum,
        limit: limitNum,
        total: cached.total,
        totalPages: cached.totalPages,
        data: cached.accounts,
      });
    }

    const cacheKey = "accounts:all";
    let accounts = await cache.get(cacheKey);

    if (!accounts) {
      console.log("Cache miss. Fetching ALL accounts from CRM (batch-parallel)...");
      const all = await fetchAllAccounts();
      accounts = all.map(({ id, name }) => ({ id, name }));
      await cache.set(cacheKey, accounts, CACHE_TTL);
    }

    return res.status(200).json({ success: true, total: accounts.length, data: accounts });
  } catch (error) {
    const status  = error.response?.status  || 500;
    const message = error.response?.data?.message || error.message;
    return res.status(status).json({ success: false, message: "Failed to fetch accounts", error: message });
  }
};

// ─── GET /api/accounts/:id — fetch one account ───────────────────────────────
const getAccountById = async (req, res) => {
  try {
    const { id } = req.params;
    const response = await espoClient.get(`/Account/${id}`, {
      params: { select: "id,name,website,emailAddress,phoneNumber" },
    });
    const a = response.data;
    return res.status(200).json({
      success: true,
      data: {
        id: a.id,
        name: a.name,
        website: a.website || null,
        emailAddress: a.emailAddress || null,
        phoneNumber: a.phoneNumber || null,
      },
    });
  } catch (error) {
    const status  = error.response?.status  || 500;
    const message = error.response?.data?.message || error.message;
    return res.status(status).json({ success: false, message: "Failed to fetch account", error: message });
  }
};

// ─── POST /api/accounts — create a new account in EspoCRM ────────────────────
const createAccount = async (req, res) => {
  try {
    const { name, website, emailAddress, phoneNumber, billingAddressCity, description } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Account name is required" });
    }

    const payload = { name: name.trim() };
    if (website)            payload.website            = website;
    if (emailAddress)       payload.emailAddress       = emailAddress;
    if (phoneNumber)        payload.phoneNumber        = phoneNumber;
    if (billingAddressCity) payload.billingAddressCity = billingAddressCity;
    if (description)        payload.description        = description;

    const response = await espoClient.post("/Account", payload);
    const account  = response.data;

    // Invalidate cached account lists so they refresh on next fetch
    await cache.del("accounts:all");
    await cache.delPattern("accounts:page:*");

    return res.status(201).json({
      success: true,
      message: "Account created successfully",
      data: { id: account.id, name: account.name },
    });
  } catch (error) {
    const status  = error.response?.status  || 500;
    const message = error.response?.data?.message || error.message;
    return res.status(status).json({ success: false, message: "Failed to create account", error: message });
  }
};

module.exports = { getAllAccounts, fetchAllAccounts, getAccountById, createAccount };
