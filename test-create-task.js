/**
 * test-create-task.js
 *
 * Creates one task linked to BOTH an Account and a Contact.
 *
 * How it works in this EspoCRM setup:
 *   - Task has one polymorphic "parent" field (parentType / parentId).
 *   - Setting parentType=Contact links the task to a contact AND
 *     automatically inherits that contact's account — giving you both.
 *   - accountId / contactId are read-only computed fields derived from parent.
 *
 * Run from the Nodejs folder:
 *   node test-create-task.js
 */

require("dotenv").config();
const espoClient = require("./Utils/espoClient");

const SELECT =
  "id,name,status,priority,parentType,parentId,parentName,accountId,accountName,contactId,contactName,assignedUsersIds,assignedUsersNames";

async function run() {
  // ── Step 1: fetch a contact that has an account linked ──────────────────
  console.log("─── Step 1: find a contact that belongs to an account ───────");

  // Fetch a small batch and pick the first contact that has an accountId
  const contactsRes = await espoClient.get("/Contact", {
    params: { maxSize: 50, offset: 0, select: "id,name,accountId,accountName" },
  });
  const allContacts = contactsRes.data?.list || [];
  const contact = allContacts.find((c) => c.accountId) || allContacts[0];

  if (!contact) throw new Error("No contacts found in EspoCRM.");
  console.log(`  ✓ Contact : ${contact.name} (${contact.id})`);
  console.log(
    `  ✓ Their Account: ${contact.accountName || "(unknown — will be inferred)"} (${contact.accountId || "?"})`
  );

  // ── Step 2: fetch one user ───────────────────────────────────────────────
  console.log("─── Step 2: fetch an assignable user ────────────────────────");
  const userRes = await espoClient.get("/User", {
    params: { maxSize: 1, offset: 0, select: "id,name" },
  });
  const user = userRes.data?.list?.[0];
  if (!user) throw new Error("No users found in EspoCRM.");
  console.log(`  ✓ User    : ${user.name} (${user.id})`);

  // ── Step 3: create the task with parentType=Contact ─────────────────────
  // This links the task to the contact AND inherits their account automatically.
  console.log("─── Step 3: create task (parentType=Contact) ────────────────");

  const payload = {
    name: `[TEST] Task with Contact+Account — ${new Date().toISOString()}`,
    status: "Not Started",
    priority: "High",
    description:
      "Automated test: parentType=Contact links both the contact and their account.",
    parentType: "Contact",
    parentId: contact.id,
    assignedUsersIds: [user.id],
    assignedUsersNames: { [user.id]: user.name },
  };

  console.log("\n  Payload:");
  console.log(JSON.stringify(payload, null, 2));

  const createRes = await espoClient.post("/Task", payload);
  const taskId = createRes.data.id;
  console.log(`\n  ✅ Created task ID: ${taskId}`);

  // ── Step 4: re-fetch to verify both links ───────────────────────────────
  console.log("─── Step 4: verify stored fields ────────────────────────────");
  const full = (
    await espoClient.get(`/Task/${taskId}`, { params: { select: SELECT } })
  ).data;

  console.log(`  Task Name    : ${full.name}`);
  console.log(`  Status       : ${full.status}`);
  console.log(`  Priority     : ${full.priority}`);
  console.log(`  Parent       : ${full.parentType} / ${full.parentId} (${full.parentName})`);
  console.log(`  Account ID   : ${full.accountId ?? "(null)"}  →  ${full.accountName ?? "(null)"}`);
  console.log(`  Contact ID   : ${full.contactId ?? "(null)"}  →  ${full.contactName ?? "(null)"}`);
  console.log(`  Assigned To  : ${JSON.stringify(full.assignedUsersNames)}`);

  // ── Assertions ───────────────────────────────────────────────────────────
  const pass = (cond, label) =>
    console.log(`  ${cond ? "✅" : "❌"} ${label}`);

  console.log("\n─── Assertions ──────────────────────────────────────────────");
  pass(full.parentType === "Contact", `parentType === "Contact"`);
  pass(full.parentId === contact.id, `parentId matches contact (${contact.id})`);
  pass(full.contactId === contact.id, `contactId populated (${contact.id})`);
  pass(!!full.accountId, `accountId populated (inferred from contact's account)`);
  pass(
    Object.keys(full.assignedUsersNames || {}).includes(user.id),
    `assigned to ${user.name}`
  );

  const allPassed =
    full.parentType === "Contact" &&
    full.parentId === contact.id &&
    full.contactId === contact.id &&
    !!full.accountId &&
    Object.keys(full.assignedUsersNames || {}).includes(user.id);

  console.log(
    allPassed
      ? "\n🎉 All assertions passed — task links both Account and Contact correctly!"
      : "\n⚠️  Some assertions failed — check the output above."
  );
}

run().catch((err) => {
  const detail = err.response?.data?.message || err.message;
  console.error("\n❌ Test failed:", detail);
  process.exit(1);
});
