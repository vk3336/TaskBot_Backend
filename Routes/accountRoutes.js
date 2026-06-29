const express = require("express");
const router  = express.Router();
const { getAllAccounts, getAccountById, createAccount } = require("../Controller/accountController");

// GET all accounts (id + name)
router.get("/", getAllAccounts);

// GET a single account by ID
router.get("/:id", getAccountById);

// POST create a new account
router.post("/", createAccount);

module.exports = router;
