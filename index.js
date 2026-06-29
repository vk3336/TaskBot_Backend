require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();

const taskRoutes = require("./Routes/taskRoutes");
const userRoutes = require("./Routes/userRoutes");
const accountRoutes = require("./Routes/accountRoutes");
const contactRoutes = require("./Routes/contactRoutes");

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/tasks", taskRoutes);
app.use("/api/users", userRoutes);
app.use("/api/accounts", accountRoutes);
app.use("/api/contacts", contactRoutes);

// Health check
app.get("/", (req, res) => {
  res.json({ message: "Task Management API is running" });
});

// Global error handler — catches Multer errors and unhandled throws
app.use((err, req, res, _next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      success: false,
      message: "File too large. Maximum allowed size is 25 MB.",
      error: err.message,
    });
  }
  if (err.name === "MulterError") {
    return res.status(400).json({
      success: false,
      message: "File upload error.",
      error: err.message,
    });
  }
  console.error("Unhandled error:", err);
  return res.status(err.status || 500).json({
    success: false,
    message: "An unexpected error occurred.",
    error: err.message,
  });
});

// ─── Cache warm-up ────────────────────────────────────────────────────────────
// Import raw fetch functions — NOT controllers — so warmup bypasses HTTP
const cache = require("./Utils/cache");
const { fetchAllUsers } = require("./Controller/userController");
const { fetchAllAccounts } = require("./Controller/accountController");
const { fetchAllContacts } = require("./Controller/contactController");
const { fetchAllTasks } = require("./Controller/taskController");

const normaliseTask = (task) => ({
  id: task.id,
  name: task.name,
  status: task.status,
  priority: task.priority || null,
  dateStart: task.dateStart || null,
  dateEnd: task.dateEnd || null,
  dateStartDate: task.dateStartDate || null,
  dateEndDate: task.dateEndDate || null,
  description: task.description || null,
  cMessage: task.cMessage || null,
  assignedUsersIds: task.assignedUsersIds || [],
  assignedUsersNames: task.assignedUsersNames || {},
  attachmentsIds: task.attachmentsIds || [],
  attachmentsNames: task.attachmentsNames || {},
  createdAt: task.createdAt || null,
  modifiedAt: task.modifiedAt || null,
});

const warmupCache = async () => {
  console.log("🔥 Starting background cache warm-up...");

  // Wait until Redis is connected (or confirmed unavailable) before writing
  // This prevents writing to in-memory only and then losing the data to Redis
  await cache.waitUntilReady();
  console.log(`📦 Cache backend: ${cache.isUsingRedis() ? "Redis" : "in-memory"}`);

  const jobs = [
    {
      key: "users:all",
      label: "Users",
      fetch: fetchAllUsers,
      transform: (list) => list.map(({ id, name }) => ({ id, name })),
    },
    {
      key: "accounts:all",
      label: "Accounts",
      fetch: fetchAllAccounts,
      transform: (list) => list.map(({ id, name }) => ({ id, name })),
    },
    {
      key: "contacts:all",
      label: "Contacts",
      fetch: fetchAllContacts,
      transform: (list) => list.map(({ id, name }) => ({ id, name })),
    },
    {
      key: "tasks:all",
      label: "Tasks",
      fetch: fetchAllTasks,
      transform: (list) =>
        list
          .map(normaliseTask)
          .filter(
            (t) => t.assignedUsersIds.length > 0 || Object.keys(t.assignedUsersNames).length > 0
          ),
    },
  ];

  // All four run concurrently; failures don't cancel others
  await Promise.allSettled(
    jobs.map(async ({ key, label, fetch, transform }) => {
      try {
        const existing = await cache.get(key);
        if (existing) {
          console.log(`⚡ ${label}: already cached (${existing.length} records), skipping.`);
          return;
        }
        const raw = await fetch();
        const data = transform(raw);
        await cache.set(key, data, key === "tasks:all" ? 300 : 600);
        console.log(`✅ ${label}: cached ${data.length} records.`);
      } catch (err) {
        console.error(`❌ ${label} warm-up failed:`, err.message);
      }
    })
  );

  console.log("🏁 Cache warm-up finished.");
};

// ─── Server start ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT} (${process.env.BASE_URL || "http://localhost:" + PORT})`);
  // Non-blocking: server accepts requests immediately while cache warms in background
  warmupCache().catch((err) => console.error("Warm-up crashed:", err.message));
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\nPort ${PORT} is already in use.\n` +
        `Stop the existing process first:\n` +
        `  netstat -ano | findstr :${PORT}\n` +
        `  taskkill /PID <pid> /F\n`
    );
    process.exit(1);
  }
  console.error("Server failed to start:", err.message);
  process.exit(1);
});