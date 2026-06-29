const espoClient = require("../Utils/espoClient");
const cache = require("../Utils/cache");
const taskQueue = require("../Utils/queue");

const CACHE_TTL = 300; // 5 minutes for tasks

const FULL_SELECT = [
  "id", "name", "status", "priority",
  "dateStart", "dateEnd", "dateStartDate", "dateEndDate",
  "description", "cMessage",
  "assignedUsersIds", "assignedUsersNames",
  "attachmentsIds", "attachmentsNames", "createdAt", "modifiedAt",
].join(",");

// ─── Normalise a raw EspoCRM task record ─────────────────────────────────────
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

// ─── Fetch ALL tasks (sequential pagination) — used by warmup ────────────────
const fetchAllTasks = async () => {
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

// ─── Validate assigned user IDs exist in EspoCRM ────────────────────────────
const validateAssignedUserIds = async (ids) => {
  if (!ids || ids.length === 0) return;

  let users = await cache.get("users:all");
  if (!users) {
    console.log("Cache miss in user validation. Fetching from CRM...");
    const response = await espoClient.get("/User", {
      params: { maxSize: 200, offset: 0, select: "id,name" },
    });
    users = (response.data?.list || []).map((u) => ({ id: u.id, name: u.name }));
    await cache.set("users:all", users, 600);
  }

  const validIds = new Set(users.map((u) => u.id));
  const invalid = ids.filter((id) => !validIds.has(id));
  if (invalid.length > 0) {
    throw Object.assign(
      new Error(`Assigned user(s) not found in EspoCRM: ${invalid.join(", ")}`),
      { statusCode: 400 }
    );
  }
};

// ─── POST /api/tasks — create a new task via the queue ───────────────────────
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
      if (val !== undefined && val !== null && val !== "") taskData[field] = val;
    }

    if (!taskData.name) {
      return res.status(400).json({ success: false, message: "Task name is required" });
    }

    if (!taskData.assignedUsersIds || taskData.assignedUsersIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Task must be assigned to at least one team member",
        error: "assignedUsersIds is required",
      });
    }

    try {
      await validateAssignedUserIds(taskData.assignedUsersIds);
    } catch (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError.message,
        error: "Invalid assigned user(s)",
      });
    }

    const jobId = await taskQueue.enqueue(taskData);
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

// ─── GET /api/tasks/queue-status/:jobId ──────────────────────────────────────
const getQueueStatus = async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await taskQueue.getJob(jobId);

    if (!job) {
      return res.status(404).json({ success: false, message: "Job not found" });
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

// ─── POST /api/tasks/:id/attachment ─────────────────────────────────────────
const uploadAttachment = async (req, res) => {
  try {
    const { id: taskId } = req.params;

    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    const { originalname, buffer } = req.file;

    const attachPayload = {
      name: originalname,
      type: "audio/mp3",
      size: buffer.length,
      role: "Attachment",
      parentType: "Task",
      parentId: taskId,
      field: "attachments",
      contents: buffer.toString("base64"),
    };

    let attachResponse;
    try {
      attachResponse = await espoClient.post("/Attachment", attachPayload);
    } catch (espoErr) {
      const status = espoErr.response?.status;
      const data = espoErr.response?.data;
      return res.status(status || 500).json({
        success: false,
        message: "EspoCRM rejected the attachment",
        error: data?.message || espoErr.message,
        detail: data,
      });
    }

    const attachment = attachResponse.data;
    if (!attachment?.id) {
      throw new Error("EspoCRM did not return an attachment ID.");
    }

    await cache.del("tasks:all");
    await cache.delPattern("tasks:user:*");

    const updatedResponse = await espoClient.get(`/Task/${taskId}`, {
      params: { select: FULL_SELECT },
    });

    return res.status(201).json({
      success: true,
      message: "Attachment uploaded successfully",
      attachment: { id: attachment.id, name: attachment.name, type: attachment.type },
      task: normaliseTask(updatedResponse.data),
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const message = error.response?.data?.message || error.message;
    return res.status(status).json({
      success: false,
      message: "Failed to upload attachment",
      error: message,
    });
  }
};

// ─── GET /api/tasks — fetch all assigned tasks with CRM-level pagination ─────
const getAllTasks = async (req, res) => {
  try {
    const { page, limit } = req.query;
    const isPaginated = page || limit;

    // ── Mode 1: Paginated — fetch only the requested page from CRM ──
    if (isPaginated) {
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 20));
      const offset = (pageNum - 1) * limitNum;

      const cacheKey = `tasks:page:${pageNum}:${limitNum}`;
      let cached = await cache.get(cacheKey);

      if (!cached) {
        console.log(`Cache miss. Fetching tasks page ${pageNum} from CRM...`);
        const response = await espoClient.get("/Task", {
          params: { maxSize: limitNum, offset, select: FULL_SELECT },
        });
        const raw = response.data?.list || [];
        const total = response.data?.total ?? 0;

        const tasks = raw
          .map(normaliseTask)
          .filter(
            (t) => t.assignedUsersIds.length > 0 || Object.keys(t.assignedUsersNames).length > 0
          );

        cached = { tasks, total, totalPages: Math.ceil(total / limitNum) };
        await cache.set(cacheKey, cached, CACHE_TTL);
      }

      return res.status(200).json({
        success: true,
        page: pageNum,
        limit: limitNum,
        total: cached.total,
        totalPages: cached.totalPages,
        data: cached.tasks,
      });
    }

    // ── Mode 2: Full list (cached) ──
    const cacheKey = "tasks:all";
    let tasks = await cache.get(cacheKey);

    if (!tasks) {
      console.log("Cache miss. Fetching all tasks from CRM...");
      const all = await fetchAllTasks();
      tasks = all
        .map(normaliseTask)
        .filter(
          (t) => t.assignedUsersIds.length > 0 || Object.keys(t.assignedUsersNames).length > 0
        );
      await cache.set(cacheKey, tasks, CACHE_TTL);
    }

    return res.status(200).json({
      success: true,
      total: tasks.length,
      data: tasks,
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

// ─── GET /api/tasks/id/:taskId ───────────────────────────────────────────────
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
      await cache.set(cacheKey, task, CACHE_TTL);
    }

    return res.status(200).json({ success: true, data: task });
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

// ─── GET /api/tasks/user/:userId — tasks for a specific user ─────────────────
const getTasksByUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { page, limit } = req.query;
    const cacheKey = `tasks:user:${userId}`;

    let userTasks = await cache.get(cacheKey);

    if (!userTasks) {
      console.log(`Cache miss. Fetching tasks for user ${userId}...`);
      let allTasks = await cache.get("tasks:all");
      if (!allTasks) {
        const all = await fetchAllTasks();
        allTasks = all
          .map(normaliseTask)
          .filter(
            (t) => t.assignedUsersIds.length > 0 || Object.keys(t.assignedUsersNames).length > 0
          );
        await cache.set("tasks:all", allTasks, CACHE_TTL);
      }
      userTasks = allTasks.filter((t) => (t.assignedUsersIds || []).includes(userId));
      await cache.set(cacheKey, userTasks, CACHE_TTL);
    }

    // In-memory pagination on the already-filtered user task list
    if (page || limit) {
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 20));
      const offset = (pageNum - 1) * limitNum;
      const slice = userTasks.slice(offset, offset + limitNum);

      return res.status(200).json({
        success: true,
        page: pageNum,
        limit: limitNum,
        total: userTasks.length,
        totalPages: Math.ceil(userTasks.length / limitNum),
        data: slice,
      });
    }

    return res.status(200).json({
      success: true,
      total: userTasks.length,
      data: userTasks,
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

module.exports = {
  createTask,
  getAllTasks,
  getTaskById,
  getTasksByUser,
  uploadAttachment,
  getQueueStatus,
  fetchAllTasks,
};