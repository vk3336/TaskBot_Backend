const espoClient = require("../Utils/espoClient");
const cache = require("../Utils/cache");
const taskQueue = require("../Utils/queue");

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
  cMessage: task.cMessage || null,
  assignedUsersIds: task.assignedUsersIds || [],
  assignedUsersNames: task.assignedUsersNames || {},
  attachmentsIds: task.attachmentsIds || [],
  attachmentsNames: task.attachmentsNames || {},
  createdAt: task.createdAt || null,
  modifiedAt: task.modifiedAt || null,
});

const FULL_SELECT = [
  "id", "name", "status", "priority",
  "dateStart", "dateEnd", "dateStartDate", "dateEndDate",
  "description", "cMessage",
  "assignedUsersIds", "assignedUsersNames",
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

// Helper: validate that every ID in assignedUsersIds exists in EspoCRM (using cache)
const validateAssignedUserIds = async (ids) => {
  if (!ids || ids.length === 0) return; // unassigned is fine

  // Try to get users from cache first
  let users = await cache.get("users:all");
  if (!users) {
    console.log("Cache miss in user validation. Fetching from CRM...");
    // Fallback to API and populate cache
    const response = await espoClient.get("/User", {
      params: { maxSize: 200, offset: 0, select: "id,name" },
    });
    users = (response.data?.list || []).map((u) => ({ id: u.id, name: u.name }));
    await cache.set("users:all", users, 600); // 10 minutes cache
  }

  const validIds = new Set(users.map((u) => u.id));
  const names = {};
  users.forEach((u) => { names[u.id] = u.name; });

  const invalid = ids.filter((id) => !validIds.has(id));
  if (invalid.length > 0) {
    const labels = invalid.join(", ");
    throw Object.assign(
      new Error(`Assigned user(s) not found in EspoCRM: ${labels}`),
      { statusCode: 400 }
    );
  }
};

// POST /api/tasks — create a new task using the Queue
const createTask = async (req, res) => {
  try {
    const raw = req.body;

    const taskData = {};
    const allowedFields = [
      "name", "priority",
      "dateStartDate", "dateEndDate", "description", "cMessage",
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

    // Reject tasks with no assigned user
    if (!taskData.assignedUsersIds || taskData.assignedUsersIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Task must be assigned to at least one team member",
        error: "assignedUsersIds is required",
      });
    }

    // Validate that all assigned user IDs actually exist in EspoCRM
    if (taskData.assignedUsersIds && taskData.assignedUsersIds.length > 0) {
      try {
        await validateAssignedUserIds(taskData.assignedUsersIds);
      } catch (validationError) {
        return res.status(400).json({
          success: false,
          message: validationError.message,
          error: "Invalid assigned user(s)",
        });
      }
    }

    console.log("Enqueuing task creation:", JSON.stringify(taskData, null, 2));

    // Enqueue the task creation request
    const jobId = await taskQueue.enqueue(taskData);

    // Wait up to 4 seconds for the job to complete to preserve frontend expectations
    const job = await taskQueue.waitForJob(jobId, 4000);

    if (job.status === "completed") {
      return res.status(201).json({
        success: true,
        message: "Task created successfully",
        data: job.result,
        jobId,
        queued: false,
      });
    } else if (job.status === "failed") {
      return res.status(500).json({
        success: false,
        message: "Failed to create task in background",
        error: job.error,
        jobId,
      });
    } else {
      // Still queued or processing (timed out waiting)
      return res.status(202).json({
        success: true,
        message: "Task creation queued in background",
        jobId,
        status: job.status,
        queued: true,
      });
    }
  } catch (error) {
    const status = error.response?.status || 500;
    const message = error.response?.data?.message || error.message;
    return res.status(status).json({
      success: false,
      message: "Failed to process task request",
      error: message,
    });
  }
};

// GET /api/tasks/queue-status/:jobId — check status of queued job
const getQueueStatus = async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await taskQueue.getJob(jobId);

    if (!job) {
      return res.status(404).json({
        success: false,
        message: "Job not found",
      });
    }

    return res.status(200).json({
      success: true,
      jobId: job.id,
      status: job.status,
      result: job.result,
      error: job.error,
      createdAt: job.createdAt,
      processedAt: job.processedAt,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to query queue status",
      error: error.message,
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

    const { originalname, buffer } = req.file;
    const mimetype = 'audio/mp3';

    const attachPayload = {
      name: originalname,
      type: mimetype,
      size: buffer.length,
      role: "Attachment",
      parentType: "Task",
      parentId: taskId,
      field: "attachments",
      contents: buffer.toString("base64"),
    };

    console.log("Uploading attachment to EspoCRM for task:", taskId, "| file:", originalname, "| size:", buffer.length);

    let attachResponse;
    try {
      attachResponse = await espoClient.post("/Attachment", attachPayload);
    } catch (espoErr) {
      const status = espoErr.response?.status;
      const data = espoErr.response?.data;
      console.error("EspoCRM /Attachment error:", status, JSON.stringify(data));
      return res.status(status || 500).json({
        success: false,
        message: "EspoCRM rejected the attachment",
        error: data?.message || espoErr.message,
        detail: data,
      });
    }

    const attachment = attachResponse.data;
    console.log("EspoCRM attachment response:", JSON.stringify(attachment));

    if (!attachment?.id) {
      throw new Error("EspoCRM did not return an attachment ID — the file may not have been linked to the task.");
    }

    // Invalidate the tasks cache since this modifies a task (adds attachment ID)
    await cache.del("tasks:all");
    await cache.delPattern("tasks:user:*");

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

// Helper to paginate an array
const paginateArray = (array, page, limit) => {
  const pageNum = parseInt(page, 10) || 1;
  const limitNum = parseInt(limit, 10) || 20;
  const offset = (pageNum - 1) * limitNum;
  
  const paginatedItems = array.slice(offset, offset + limitNum);
  const totalPages = Math.ceil(array.length / limitNum);

  return {
    page: pageNum,
    limit: limitNum,
    totalPages,
    total: array.length,
    data: paginatedItems,
  };
};

// GET /api/tasks — fetch all assigned tasks with cache and pagination
const getAllTasks = async (req, res) => {
  try {
    const cacheKey = "tasks:all";
    let tasks = await cache.get(cacheKey);

    if (!tasks) {
      console.log("Cache miss. Fetching all tasks from CRM...");
      const allTasks = await fetchAllTasksFromEspo();

      tasks = allTasks
        .map(normaliseTask)
        .filter(
          (task) =>
            task.assignedUsersIds.length > 0 ||
            Object.keys(task.assignedUsersNames).length > 0
        );

      // Cache all tasks for 5 minutes (300 seconds)
      await cache.set(cacheKey, tasks, 300);
    }

    const { page, limit } = req.query;
    if (page || limit) {
      const paginatedResult = paginateArray(tasks, page, limit);
      return res.status(200).json({
        success: true,
        ...paginatedResult,
        cached: true,
      });
    }

    return res.status(200).json({
      success: true,
      total: tasks.length,
      data: tasks,
      cached: true,
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
    const cacheKey = `task:${taskId}`;
    
    let task = await cache.get(cacheKey);
    if (!task) {
      const response = await espoClient.get(`/Task/${taskId}`, {
        params: { select: FULL_SELECT },
      });
      task = normaliseTask(response.data);
      await cache.set(cacheKey, task, 300); // cache single task for 5 minutes
    }

    return res.status(200).json({
      success: true,
      data: task,
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

// GET /api/tasks/user/:userId — fetch all tasks for a user by their EspoCRM user ID (with caching and pagination)
const getTasksByUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const cacheKey = `tasks:user:${userId}`;

    let userTasks = await cache.get(cacheKey);

    if (!userTasks) {
      console.log(`Cache miss. Fetching tasks for user ${userId}...`);
      
      // Get all tasks (which will load from cache if available, else fetch CRM)
      let allTasks = await cache.get("tasks:all");
      if (!allTasks) {
        const fetchAll = await fetchAllTasksFromEspo();
        allTasks = fetchAll
          .map(normaliseTask)
          .filter(
            (task) =>
              task.assignedUsersIds.length > 0 ||
              Object.keys(task.assignedUsersNames).length > 0
          );
        await cache.set("tasks:all", allTasks, 300);
      }

      userTasks = allTasks.filter((task) => (task.assignedUsersIds || []).includes(userId));
      
      // Cache this user's task list for 5 minutes
      await cache.set(cacheKey, userTasks, 300);
    }

    const { page, limit } = req.query;
    if (page || limit) {
      const paginatedResult = paginateArray(userTasks, page, limit);
      return res.status(200).json({
        success: true,
        ...paginatedResult,
        cached: true,
      });
    }

    return res.status(200).json({
      success: true,
      total: userTasks.length,
      data: userTasks,
      cached: true,
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

module.exports = { createTask, getAllTasks, getTaskById, getTasksByUser, uploadAttachment, getQueueStatus };
