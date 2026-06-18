require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();

const taskRoutes = require("./Routes/taskRoutes");
const userRoutes = require("./Routes/userRoutes");

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/tasks", taskRoutes);
app.use("/api/users", userRoutes);

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

// Fix #8: log PORT not BASE_URL
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
