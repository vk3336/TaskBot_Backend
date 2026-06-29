const crypto = require("crypto");
const cache = require("./cache");
const espoClient = require("./espoClient");

// Internal job list (in-memory queue)
const pendingJobs = [];
let isWorkerRunning = false;

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
  accountId: task.accountId || null,
  accountName: task.accountName || null,
  contactId: task.contactId || null,
  contactName: task.contactName || null,
  attachmentsIds: task.attachmentsIds || [],
  attachmentsNames: task.attachmentsNames || {},
  createdAt: task.createdAt || null,
  modifiedAt: task.modifiedAt || null,
});

/**
 * Worker function to process jobs sequentially
 */
const runWorker = async () => {
  if (isWorkerRunning) return;
  isWorkerRunning = true;

  console.log("🛠️ Task queue worker started.");

  while (pendingJobs.length > 0) {
    const jobId = pendingJobs.shift();
    const jobKey = `job:${jobId}`;

    try {
      const job = await cache.get(jobKey);
      if (!job) continue;

      // Update status to processing
      job.status = "processing";
      job.processedAt = new Date().toISOString();
      await cache.set(jobKey, job, 3600); // cache for 1 hour

      console.log(`Processing job ${jobId} (Task: "${job.data.name}")`);

      // Make API call to EspoCRM
      const response = await espoClient.post("/Task", job.data);
      const createdTask = response.data;

      // Update job to completed
      job.status = "completed";
      job.result = normaliseTask(createdTask);
      await cache.set(jobKey, job, 3600);

      // Invalidate tasks cache keys so lists refresh
      await cache.del("tasks:all");
      await cache.delPattern("tasks:user:*");

      console.log(`Job ${jobId} completed successfully.`);
    } catch (error) {
      console.error(`Error processing job ${jobId}:`, error.message);
      
      // Update job to failed
      const job = await cache.get(jobKey);
      if (job) {
        const errMsg = error.response?.data?.message || error.message;
        job.status = "failed";
        job.error = errMsg;
        await cache.set(jobKey, job, 3600);
      }
    }
  }

  isWorkerRunning = false;
  console.log("🛠️ Task queue worker idle.");
};

const taskQueue = {
  /**
   * Enqueue a new task creation request
   */
  enqueue: async (taskData) => {
    const jobId = `job_${crypto.randomBytes(8).toString("hex")}`;
    const jobKey = `job:${jobId}`;

    const job = {
      id: jobId,
      status: "queued",
      data: taskData,
      createdAt: new Date().toISOString(),
      processedAt: null,
      result: null,
      error: null,
    };

    // Store job in cache (Redis/memory)
    await cache.set(jobKey, job, 3600); // 1 hour TTL

    // Push to pending queue
    pendingJobs.push(jobId);

    // Trigger worker asynchronously
    runWorker();

    return jobId;
  },

  /**
   * Get job details/status
   */
  getJob: async (jobId) => {
    const jobKey = `job:${jobId}`;
    return await cache.get(jobKey);
  },

  /**
   * Wait for a job to complete or fail, up to timeoutMs
   */
  waitForJob: async (jobId, timeoutMs = 4000) => {
    const jobKey = `job:${jobId}`;
    const startTime = Date.now();
    const interval = 100; // Poll every 100ms

    while (Date.now() - startTime < timeoutMs) {
      const job = await cache.get(jobKey);
      if (!job) return null;

      if (job.status === "completed" || job.status === "failed") {
        return job;
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    // Timeout reached, return current job state
    return await cache.get(jobKey);
  },
};

module.exports = taskQueue;
