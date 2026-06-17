const espoClient = require("../Utils/espoClient");

// GET /api/users — fetch all users (id + name only)
const getAllUsers = async (_req, res) => {
  try {
    const response = await espoClient.get("/User", {
      params: { maxSize: 200 },
    });

    const users = response.data?.list || [];

    const result = users.map((user) => ({
      id: user.id,
      name: user.name,
    }));

    return res.status(200).json({
      success: true,
      total: result.length,
      data: result,
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const message = error.response?.data?.message || error.message;
    return res.status(status).json({
      success: false,
      message: "Failed to fetch users",
      error: message,
    });
  }
};

module.exports = { getAllUsers };
