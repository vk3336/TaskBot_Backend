const espoClient = require("../Utils/espoClient");

// Helper: build a normalised task object from an EspoCRM task record
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
  assignedUsersIds: task.assignedUsersIds || [],
  assignedUsersNames: task.assignedUsersNames || {},
  attachmentsIds: task.attachmentsIds || [],
  attachmentsNames: task.attachmentsNames || {},
  createdAt: task.createdAt || null,
  modifiedAt: task.modifiedAt || null,
});

// Fix #1 + #2 + #3: fetch ALL tasks in paginated list calls with full fields.
// No per-record fetches, no N+1, no silent data loss from allSettled.
const FULL_SELECT = [
  "id", "name", "status", "priority",
  "dateStart", "dateEnd", "dateStartDate", "dateEndDate",
  "description", "assignedUsersIds", "assignedUsersNames",
  "attachmentsIds", "attachmentsNames", "createdAt", "modifiedAt",
].join(",");

const fetchAllTasksFromEspo = async () => {
  const PAGE = 200;
  let offset = 0;
  let collected = [];

  while (true) {
    const response = await espoClient.get("/Task", {
      params: { maxSize: PAGE, offset, select: FULL_SELECT },
    });
    const page = response.data?.list || [];
    const total = response.data?.total ?? page.length;
    collected = collected.concat(page);
    offset += page.length;
    if (offset >= total || page.length === 0) break;
  }

  return collected;
};

// POST /api/tasks — create a new task in EspoCRM
const createTask = async (req, res) => {
  try {
    const raw = req.body;

    const taskData = {};
    const allowedFields = [
      "name", "priority",
      "dateStartDate", "dateEndDate", "description",
      "parentId", "parentType", "accountId", "contactId",
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

    // Fetch updated task detail for the response
    const updatedResponse = await espoClient.get(`/Task/${taskId}`, {
      params: { select: FULL_SELECT },
    });

    return res.status(201).json({
      success: true,
      message: "Attachment uploaded successfully",
      attachment: {
        id: attachment.id,
        name: attachment.name,
        type: attachment.type,
      },
      task: normaliseTask(updatedResponse.data),
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

// GET /api/tasks — fetch all assigned tasks
const getAllTasks = async (req, res) => {
  try {
    const allTasks = await fetchAllTasksFromEspo();

    const result = allTasks
      .map(normaliseTask)
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
    const response = await espoClient.get(`/Task/${taskId}`, {
      params: { select: FULL_SELECT },
    });
    return res.status(200).json({
      success: true,
      data: normaliseTask(response.data),
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

// GET /api/tasks/:username — fetch all tasks for a user by exact display name
const getTasksByUser = async (req, res) => {
  try {
    const { username } = req.params;
    const lowerUsername = username.toLowerCase();

    const allTasks = await fetchAllTasksFromEspo();

    // Fix #4: exact full-name match instead of partial includes()
    // The frontend passes the exact name it received from the task list, so
    // partial matching only risks returning the wrong person's tasks.
    const result = allTasks
      .map(normaliseTask)
      .filter((task) => {
        const names = Object.values(task.assignedUsersNames || {}).map((n) =>
          n.toLowerCase()
        );
        return names.some((n) => n === lowerUsername);
      });

    // Fix #5: empty result is a valid state (200), not a 404
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
