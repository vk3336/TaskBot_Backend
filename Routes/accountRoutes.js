const express = require("express");
const router = express.Router();
const { getAllAccounts } = require("../Controller/accountController");

// GET all accounts (id + name)
router.get("/", getAllAccounts);

module.exports = router;
