const express = require("express");
const router  = express.Router();
const { getAllContacts, getContactById, createContact } = require("../Controller/contactController");

// GET all contacts (id + name + accountId + accountName)
router.get("/", getAllContacts);

// GET a single contact by ID (includes linked accountId + accountName)
router.get("/:id", getContactById);

// POST create a new contact (optionally linked to an account via accountId)
router.post("/", createContact);

module.exports = router;
