const express = require("express");
const router = express.Router();
const { getAllContacts } = require("../Controller/contactController");

// GET all contacts (id + name)
router.get("/", getAllContacts);

module.exports = router;
