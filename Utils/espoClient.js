const axios = require("axios");

const espoClient = axios.create({
  baseURL: `${process.env.ESPO_BASE_URL}/api/v1`,
  headers: {
    "X-Api-Key": process.env.ESPO_API_KEY,
    "Content-Type": "application/json",
  },
});

module.exports = espoClient;
