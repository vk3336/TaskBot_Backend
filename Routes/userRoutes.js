const express = require("express");
const router = express.Router();
const { getAllUsers } = require("../Controller/userController");

// GET all users (id + name)
router.get("/", getAllUsers);

module.exports = router;
