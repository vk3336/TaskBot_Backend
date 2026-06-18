const express = require("express");
const multer = require("multer");
const router = express.Router();
const { createTask, getAllTasks, getTaskById, getTasksByUser, uploadAttachment } = require("../Controller/taskController");

// multer stores the file in memory so we can forward the buffer to EspoCRM
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB max
});

// GET all tasks (full detail fetched per record via GET /Task/:id)
router.get("/", getAllTasks);

// GET a single task by EspoCRM record ID  —  must come before /:username
router.get("/id/:taskId", getTaskById);

// GET all tasks for a specific user by their EspoCRM user ID (exact, unique match)
router.get("/user/:userId", getTasksByUser);

// POST create a new task
router.post("/", createTask);

// POST upload audio/file attachment to an existing task
router.post("/:id/attachment", upload.single("file"), uploadAttachment);

module.exports = router;
