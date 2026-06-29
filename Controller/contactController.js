const espoClient = require("../Utils/espoClient");
const cache = require("../Utils/cache");

const PAGE_SIZE = 200;
const CACHE_TTL = 600; // 10 minutes

// ─── Fetch a single page from EspoCRM ────────────────────────────────────────
const fetchContactPage = async (offset, limit) => {
  const response = await espoClient.get("/Contact", {
    params: { maxSize: limit, offset, select: "id,name" },
  });
  return {
    list: response.data?.list || [],
    total: response.data?.total ?? 0,
  };
};

// ─── Fetch ALL contacts (batch-parallel) — used by warmup ───────────────────
const fetchAllContacts = async () => {
  const { list: firstPage, total } = await fetchContactPage(0, PAGE_SIZE);
  if (total <= PAGE_SIZE) return firstPage;

  const CONCURRENCY = 5;
  const offsets = [];
  for (let off = PAGE_SIZE; off < total; off += PAGE_SIZE) offsets.push(off);

  let all = [...firstPage];
  for (let i = 0; i < offsets.length; i += CONCURRENCY) {
    const batch = offsets.slice(i, i + CONCURRENCY);
    const pages = await Promise.all(batch.map((off) => fetchContactPage(off, PAGE_SIZE)));
    for (const { list } of pages) all = all.concat(list);
  }
  return all;
};

// ─── GET /api/contacts ───────────────────────────────────────────────────────
// Supports two modes:
//   1. ?page=&limit=  → CRM-level pagination (fast, no full fetch)
//   2. No query params → full cached list
const getAllContacts = async (req, res) => {
  try {
    const { page, limit } = req.query;
    const isPaginated = page || limit;

    // ── Mode 1: Paginated — fetch only the requested page from CRM ──
    if (isPaginated) {
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 20));
      const offset = (pageNum - 1) * limitNum;

      const cacheKey = `contacts:page:${pageNum}:${limitNum}`;
      let cached = await cache.get(cacheKey);

      if (!cached) {
        console.log(`Cache miss. Fetching contacts page ${pageNum} from CRM...`);
        const { list, total } = await fetchContactPage(offset, limitNum);
        const contacts = list.map(({ id, name }) => ({ id, name }));

        cached = { contacts, total, totalPages: Math.ceil(total / limitNum) };
        await cache.set(cacheKey, cached, CACHE_TTL);
      }

      return res.status(200).json({
        success: true,
        page: pageNum,
        limit: limitNum,
        total: cached.total,
        totalPages: cached.totalPages,
        data: cached.contacts,
      });
    }

    // ── Mode 2: Full list (cached) ──
    const cacheKey = "contacts:all";
    let contacts = await cache.get(cacheKey);

    if (!contacts) {
      console.log("Cache miss. Fetching ALL contacts from CRM (batch-parallel)...");
      const all = await fetchAllContacts();
      contacts = all.map(({ id, name }) => ({ id, name }));
      await cache.set(cacheKey, contacts, CACHE_TTL);
    }

    return res.status(200).json({
      success: true,
      total: contacts.length,
      data: contacts,
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const message = error.response?.data?.message || error.message;
    return res.status(status).json({
      success: false,
      message: "Failed to fetch contacts",
      error: message,
    });
  }
};

module.exports = { getAllContacts, fetchAllContacts };