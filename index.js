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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${process.env.BASE_URL}`);
});
