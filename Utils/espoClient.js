const axios = require("axios");

// Fix #7: validate required env vars at startup so the server refuses to boot
// instead of failing silently on the first CRM request
const ESPO_BASE_URL = process.env.ESPO_BASE_URL;
const ESPO_API_KEY = process.env.ESPO_API_KEY;

if (!ESPO_BASE_URL) {
  throw new Error("[espoClient] ESPO_BASE_URL is not set. Add it to your .env file.");
}
if (!ESPO_API_KEY) {
  throw new Error("[espoClient] ESPO_API_KEY is not set. Add it to your .env file.");
}

const espoClient = axios.create({
  baseURL: `${ESPO_BASE_URL}/api/v1`,
  headers: {
    "X-Api-Key": ESPO_API_KEY,
    "Content-Type": "application/json",
  },
});

module.exports = espoClient;
