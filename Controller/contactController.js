const espoClient = require("../Utils/espoClient");
const cache = require("../Utils/cache");

const PAGE_SIZE = 200;
const CACHE_TTL = 600; // 10 minutes

// ─── Fetch a single page of contacts (with accountId for interlinking) ───────
const fetchContactPage = async (offset, limit) => {
  const response = await espoClient.get("/Contact", {
    params: { maxSize: limit, offset, select: "id,name,accountId,accountName" },
  });
  return {
    list: response.data?.list || [],
    total: response.data?.total ?? 0,
  };
};

// ─── Fetch ALL contacts (batch-parallel) — used by warmup ────────────────────
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

// ─── Normalise a contact record (always include accountId + accountName) ─────
const normaliseContact = ({ id, name, accountId, accountName }) => ({
  id,
  name,
  accountId:   accountId   || null,
  accountName: accountName || null,
});

// ─── GET /api/contacts ───────────────────────────────────────────────────────
// Returns { id, name, accountId, accountName } per contact so the frontend
// can auto-fill the account when a contact is selected.
const getAllContacts = async (req, res) => {
  try {
    const { page, limit } = req.query;
    const isPaginated = page || limit;

    if (isPaginated) {
      const pageNum  = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 20));
      const offset   = (pageNum - 1) * limitNum;

      const cacheKey = `contacts:page:${pageNum}:${limitNum}`;
      let cached = await cache.get(cacheKey);

      if (!cached) {
        console.log(`Cache miss. Fetching contacts page ${pageNum} from CRM...`);
        const { list, total } = await fetchContactPage(offset, limitNum);
        const contacts = list.map(normaliseContact);
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

    const cacheKey = "contacts:all";
    let contacts = await cache.get(cacheKey);

    if (!contacts) {
      console.log("Cache miss. Fetching ALL contacts from CRM (batch-parallel)...");
      const all = await fetchAllContacts();
      contacts = all.map(normaliseContact);
      await cache.set(cacheKey, contacts, CACHE_TTL);
    }

    return res.status(200).json({ success: true, total: contacts.length, data: contacts });
  } catch (error) {
    const status  = error.response?.status  || 500;
    const message = error.response?.data?.message || error.message;
    return res.status(status).json({ success: false, message: "Failed to fetch contacts", error: message });
  }
};

// ─── GET /api/contacts/:id — single contact with its linked account ───────────
const getContactById = async (req, res) => {
  try {
    const { id } = req.params;
    const response = await espoClient.get(`/Contact/${id}`, {
      params: { select: "id,name,accountId,accountName,emailAddress,phoneNumber" },
    });
    const c = response.data;
    return res.status(200).json({
      success: true,
      data: {
        id:           c.id,
        name:         c.name,
        accountId:    c.accountId    || null,
        accountName:  c.accountName  || null,
        emailAddress: c.emailAddress || null,
        phoneNumber:  c.phoneNumber  || null,
      },
    });
  } catch (error) {
    const status  = error.response?.status  || 500;
    const message = error.response?.data?.message || error.message;
    return res.status(status).json({ success: false, message: "Failed to fetch contact", error: message });
  }
};

// ─── POST /api/contacts — create a new contact in EspoCRM ────────────────────
// Pass accountId to link the contact to an existing account immediately.
// When the task uses parentType=Contact, EspoCRM auto-populates both
// contactId AND accountId on the task record.
const createContact = async (req, res) => {
  try {
    const { firstName, lastName, name, accountId, emailAddress, phoneNumber, description } = req.body;

    // Accept either a combined `name` OR separate first/last
    const resolvedFirst = firstName?.trim() || (name ? name.trim().split(" ")[0] : "");
    const resolvedLast  = lastName?.trim()  || (name ? name.trim().split(" ").slice(1).join(" ") : "");

    if (!resolvedFirst) {
      return res.status(400).json({ success: false, message: "Contact first name is required" });
    }

    const payload = { firstName: resolvedFirst };
    if (resolvedLast)   payload.lastName     = resolvedLast;
    if (accountId)      payload.accountId    = accountId;
    if (emailAddress)   payload.emailAddress = emailAddress;
    if (phoneNumber)    payload.phoneNumber  = phoneNumber;
    if (description)    payload.description  = description;

    const response = await espoClient.post("/Contact", payload);
    const contact  = response.data;

    // Re-fetch to pick up the accountName EspoCRM resolves from accountId
    let resolvedAccountName = null;
    if (contact.id) {
      try {
        const refetch = await espoClient.get(`/Contact/${contact.id}`, {
          params: { select: "id,name,accountId,accountName" },
        });
        resolvedAccountName = refetch.data?.accountName || null;
      } catch { /* non-fatal — accountName just won't be returned */ }
    }

    // Invalidate cached contact lists so they refresh on next fetch
    await cache.del("contacts:all");
    await cache.delPattern("contacts:page:*");

    return res.status(201).json({
      success: true,
      message: "Contact created successfully",
      data: {
        id:          contact.id,
        name:        contact.name,
        accountId:   contact.accountId || accountId || null,
        accountName: resolvedAccountName,
      },
    });
  } catch (error) {
    const status  = error.response?.status  || 500;
    const message = error.response?.data?.message || error.message;
    return res.status(status).json({ success: false, message: "Failed to create contact", error: message });
  }
};

module.exports = { getAllContacts, fetchAllContacts, getContactById, createContact };
