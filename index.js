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

// Fix #6: global error middleware — catches Multer errors (file too large, wrong type)
// and any other unhandled errors, and always returns consistent JSON
app.use((err, req, res, _next) => {
  // Multer file size limit exceeded
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      success: false,
      message: "File too large. Maximum allowed size is 25 MB.",
      error: err.message,
    });
  }
  // Multer unexpected field or other multer errors
  if (err.name === "MulterError") {
    return res.status(400).json({
      success: false,
      message: "File upload error.",
      error: err.message,
    });
  }
  // Generic fallback
  console.error("Unhandled error:", err);
  return res.status(err.status || 500).json({
    success: false,
    message: "An unexpected error occurred.",
    error: err.message,
  });
});

const { getAllUsers } = require("./Controller/userController");
const { getAllAccounts } = require("./Controller/accountController");
const { getAllContacts } = require("./Controller/contactController");
const { getAllTasks } = require("./Controller/taskController");

const warmupCache = async () => {
  console.log("🔥 Starting background cache warm-up...");
  const dummyRes = {
    status: function() { return this; },
    json: function() { return this; }
  };
  
  try {
    await Promise.all([
      getAllUsers({ query: {} }, dummyRes).catch(e => console.error("User warm-up error:", e.message)),
      getAllAccounts({ query: {} }, dummyRes).catch(e => console.error("Account warm-up error:", e.message)),
      getAllContacts({ query: {} }, dummyRes).catch(e => console.error("Contact warm-up error:", e.message)),
      getAllTasks({ query: {} }, dummyRes).catch(e => console.error("Task warm-up error:", e.message))
    ]);
    console.log("✅ Cache warm-up completed successfully!");
  } catch (err) {
    console.warn("⚠️ Cache warm-up completed with errors:", err.message);
  }
};

// Fix #8: log PORT; handle EADDRINUSE so the process doesn't silently exit
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${process.env.BASE_URL}`);
  warmupCache();
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\nPort ${PORT} is already in use. Another server is still running.\n` +
        `Stop it first, then try again:\n` +
        `  netstat -ano | findstr :${PORT}\n` +
        `  taskkill /PID <pid> /F\n`
    );
    process.exit(1);
  }
  console.error("Server failed to start:", err.message);
  process.exit(1);
});
