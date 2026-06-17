const espoClient = require("../Utils/espoClient");

// Helper: fetch a single task by ID and return its full detail
const fetchTaskById = async (taskId) => {
  const response = await espoClient.get(`/Task/${taskId}`);
  return response.data;
};

// Helper: build a normalised task object from EspoCRM task detail
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
  // Use the multi-user arrays that EspoCRM actually returns
  assignedUsersIds: task.assignedUsersIds || [],
  assignedUsersNames: task.assignedUsersNames || {},
  attachmentsIds: task.attachmentsIds || [],
  attachmentsNames: task.attachmentsNames || {},
  createdAt: task.createdAt || null,
  modifiedAt: task.modifiedAt || null,
});

// POST /api/tasks — create a new task in EspoCRM (supports multi-assignee + audio attachment)
const createTask = async (req, res) => {
  try {
    const raw = req.body;

    const taskData = {};
    const allowedFields = [
      "name", "priority",
      "dateStartDate", "dateEndDate", "description",
      "parentId", "parentType", "accountId", "contactId",
      // multi-user fields
      "assignedUsersIds", "assignedUsersNames",
    ];

    for (const field of allowedFields) {
      const val = raw[field];
      if (val !== undefined && val !== null && val !== "") {
        taskData[field] = val;
      }
    }

    if (!taskData.name) {
      return res.status(400).json({ success: false, message: "Task name is required" });
    }

    console.log("Sending to EspoCRM:", JSON.stringify(taskData, null, 2));

    const response = await espoClient.post("/Task", taskData);
    const createdTask = response.data;

    return res.status(201).json({
      success: true,
      message: "Task created successfully",
      data: normaliseTask(createdTask),
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const message = error.response?.data?.message || error.message;
    console.log("EspoCRM error:", status, JSON.stringify(error.response?.data));
    return res.status(status).json({
      success: false,
      message: "Failed to create task",
      error: message,
    });
  }
};

// POST /api/tasks/:id/attachment — upload audio/file and link to a task
const uploadAttachment = async (req, res) => {
  try {
    const { id: taskId } = req.params;

    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    const { originalname, mimetype, buffer } = req.file;

    // Step 1: Upload the file to EspoCRM as an Attachment
    // EspoCRM requires: name, type, size, role, relatedType, relatedId, field, contents (base64)
    const attachPayload = {
      name: originalname,
      type: mimetype,
      size: buffer.length,
      role: "Attachment",
      relatedType: "Task",
      relatedId: taskId,
      field: "attachments",
      contents: buffer.toString("base64"),
    };

    console.log("Uploading attachment to EspoCRM for task:", taskId);
    const attachResponse = await espoClient.post("/Attachment", attachPayload);
    const attachment = attachResponse.data;

    // Step 2: Fetch updated task to return current state
    const updatedTask = await fetchTaskById(taskId);

    return res.status(201).json({
      success: true,
      message: "Attachment uploaded successfully",
      attachment: {
        id: attachment.id,
        name: attachment.name,
        type: attachment.type,
      },
      task: normaliseTask(updatedTask),
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const message = error.response?.data?.message || error.message;
    console.log("Attachment upload error:", status, JSON.stringify(error.response?.data));
    return res.status(status).json({
      success: false,
      message: "Failed to upload attachment",
      error: message,
    });
  }
};

// GET /api/tasks — fetch all tasks using direct GET /Task/:id per record
const getAllTasks = async (req, res) => {
  try {
    // First get a list of task IDs
    const listResponse = await espoClient.get("/Task", {
      params: { maxSize: 200, select: "id,name" },
    });

    const taskList = listResponse.data?.list || [];

    // Fetch full detail for each task by ID (parallel)
    const detailResults = await Promise.allSettled(
      taskList.map((t) => fetchTaskById(t.id))
    );

    const result = detailResults
      .filter((r) => r.status === "fulfilled")
      .map((r) => normaliseTask(r.value))
      .filter(
        (task) =>
          task.assignedUsersIds.length > 0 ||
          Object.keys(task.assignedUsersNames).length > 0
      );

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
      message: "Failed to fetch tasks",
      error: message,
    });
  }
};

// GET /api/tasks/id/:taskId — fetch a single task by its EspoCRM record ID
const getTaskById = async (req, res) => {
  try {
    const { taskId } = req.params;
    const task = await fetchTaskById(taskId);
    return res.status(200).json({
      success: true,
      data: normaliseTask(task),
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const message = error.response?.data?.message || error.message;
    return res.status(status).json({
      success: false,
      message: "Failed to fetch task",
      error: message,
    });
  }
};

// GET /api/tasks/:username — fetch all tasks for a particular user name
const getTasksByUser = async (req, res) => {
  try {
    const { username } = req.params;

    const taskResponse = await espoClient.get("/Task", {
      params: {
        maxSize: 200,
        select: "id,name",
      },
    });

    const taskList = taskResponse.data?.list || [];

    // Fetch full details in parallel
    const detailResults = await Promise.allSettled(
      taskList.map((t) => fetchTaskById(t.id))
    );

    const result = detailResults
      .filter((r) => r.status === "fulfilled")
      .map((r) => normaliseTask(r.value))
      .filter((task) => {
        // Check if user name exists in assignedUsersNames map values
        const names = Object.values(task.assignedUsersNames || {}).map((n) =>
          n.toLowerCase()
        );
        return names.some((n) => n.includes(username.toLowerCase()));
      });

    if (result.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No tasks found for user "${username}"`,
      });
    }

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
      message: "Failed to fetch tasks for user",
      error: message,
    });
  }
};

module.exports = { createTask, getAllTasks, getTaskById, getTasksByUser, uploadAttachment };
