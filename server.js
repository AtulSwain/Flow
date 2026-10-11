const express    = require("express");
const http       = require("http");
const fs         = require("fs");
const crypto     = require("crypto");
const path       = require("path");
const mysql      = require("mysql2");
const jwt        = require("jsonwebtoken");
const cors       = require("cors");
const bcryptjs   = require("bcryptjs");
const { Server } = require("socket.io");
let multer = null;
let nodemailer = null;
try { multer = require("multer"); } catch { multer = null; }
try { nodemailer = require("nodemailer"); } catch { nodemailer = null; }

// ═══════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════
const PORT   = process.env.PORT || 5000;
const SECRET = process.env.JWT_SECRET || "flowdesk_secret_key";
// Vercel's deployment filesystem is read-only; only /tmp is writable there.
const IS_VERCEL  = !!process.env.VERCEL;
const UPLOAD_DIR = IS_VERCEL ? path.join("/tmp", "uploads") : path.join(__dirname, "public", "uploads");
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
} catch (err) {
  console.error("Could not create upload dir:", err.message);
}

// ═══════════════════════════════════════════
//  EXPRESS + HTTP SERVER
// ═══════════════════════════════════════════
const app    = express();
const server = http.createServer(app);

// ═══════════════════════════════════════════
//  MIDDLEWARE
// ═══════════════════════════════════════════
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));

const upload = multer ? multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${safeName}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
}) : null;

const mailTransport = nodemailer ? nodemailer.createTransport(
  process.env.SMTP_HOST ? {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined
  } : { jsonTransport: true }
) : null;

async function sendEmail(to, subject, text) {
  if (!mailTransport || !to) return { skipped: true };
  try {
    await mailTransport.sendMail({
      from: process.env.MAIL_FROM || "FlowDesk <no-reply@flowdesk.local>",
      to,
      subject,
      text
    });
    return { sent: true };
  } catch (err) {
    console.error("Email send failed:", err.message);
    return { error: err.message };
  }
}

// ═══════════════════════════════════════════
//  MYSQL CONNECTION
// ═══════════════════════════════════════════
const db = mysql.createPool({
  host              : process.env.DB_HOST || "localhost",
  port              : Number(process.env.DB_PORT || 3306),
  user              : process.env.DB_USER || "root",
  password          : process.env.DB_PASSWORD ?? "swain@123456789",
  database          : process.env.DB_NAME || "employeeslogin",
  waitForConnections: true,
  connectionLimit   : 10,
  queueLimit        : 0,
});
const dbp = db.promise();

db.getConnection((err, connection) => {
  if (err) {
    console.error("❌ MySQL connection failed:", err.message);
    // Locally a missing DB is fatal; on serverless keep serving static pages.
    if (!IS_VERCEL) process.exit(1);
    return;
  }
  console.log("✅ MySQL connected (pool ready)");
  connection.release();
});

function asBool(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function isBcryptHash(value) {
  return typeof value === "string" && /^\$2[aby]\$/.test(value);
}

async function verifyPassword(inputPassword, storedPassword) {
  if (isBcryptHash(storedPassword)) return bcryptjs.compare(String(inputPassword), storedPassword);
  return String(inputPassword) === String(storedPassword);
}

function getPersonalRoom(userId) {
  return userId ? `user_${userId}` : null;
}

function getWorkspaceRoom(workspaceId) {
  return workspaceId ? `workspace_${workspaceId}` : null;
}

function emitToRole(role, event, payload) {
  for (const [socketId, user] of users.entries()) {
    if (user.role === role) io.to(socketId).emit(event, payload);
  }
}

function emitToCompany(role, companyId, event, payload) {
  for (const [socketId, user] of users.entries()) {
    if (user.role !== role) continue;
    if (companyId && String(user.company_id) !== String(companyId)) continue;
    io.to(socketId).emit(event, payload);
  }
}

function emitToUserId(userId, event, payload) {
  const room = getPersonalRoom(userId);
  if (room) {
    io.to(room).emit(event, payload);
  }
}

async function logActivity(actorId, actorRole, action, details = "") {
  await dbp.query(
    "INSERT INTO activity_logs (actor_id, actor_role, action, details) VALUES (?, ?, ?, ?)",
    [actorId || null, actorRole || "system", action, details]
  );
}

async function createNotification(userId, role, title, message, type = "info", requestId = null, taskId = null) {
  if ((requestId || taskId) && userId) {
    const [existing] = await dbp.query(
      `SELECT * FROM notifications
       WHERE user_id = ? AND type = ? AND COALESCE(request_id, 0) = COALESCE(?, 0) AND COALESCE(task_id, 0) = COALESCE(?, 0)
       ORDER BY created_at DESC LIMIT 1`,
      [userId, type, requestId, taskId]
    );
    if (existing[0]) return existing[0];
  }
  const [result] = await dbp.query(
    "INSERT INTO notifications (user_id, role, title, body, message, type, request_id, task_id, is_read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
    [userId || null, role || null, title, message, message, type, requestId, taskId]
  );
  return {
    id: result.insertId,
    user_id: userId || null,
    role: role || null,
    title,
    body: message,
    message,
    type,
    request_id: requestId,
    task_id: taskId,
    is_read: 0,
    created_at: new Date().toISOString(),
  };
}

async function createNotificationForUser(userId, role, title, message, type = "info", requestId = null, taskId = null) {
  if (!userId) return null;
  const notification = await createNotification(userId, role, title, message, type, requestId, taskId);
  emitToUserId(userId, "notification:new", notification);
  emitToUserId(userId, "new_notification", notification);
  return notification;
}

async function createNotificationsForCompanyManagers(companyId, employeeName, requestTitle, requestMessage, requestId) {
  const [managers] = await dbp.query("SELECT id, name FROM managers WHERE company_id = ?", [companyId]);
  const title = "New employee request";
  const message = `${employeeName}: ${requestTitle} - ${requestMessage}`;
  const notifications = [];
  for (const manager of managers) {
    const note = await createNotification(manager.id, "manager", title, message, "new_request", requestId, null);
    notifications.push(note);
    emitToUserId(manager.id, "notification:new", note);
    emitToUserId(manager.id, "new_notification", note);
  }
  return notifications;
}

async function ensureNotificationColumns() {
  const dbName = db.config.connectionConfig.database || "employeeslogin";
  const [columns] = await dbp.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME IN (?, ?, ?)",
    [dbName, "notifications", "body", "request_id", "is_read"]
  );
  const existing = new Set(columns.map(col => col.COLUMN_NAME));
  if (!existing.has("body")) {
    await dbp.query("ALTER TABLE notifications ADD COLUMN body TEXT NOT NULL AFTER title");
  }
  if (!existing.has("request_id")) {
    await dbp.query("ALTER TABLE notifications ADD COLUMN request_id INT NULL AFTER type");
  }
  if (!existing.has("is_read")) {
    await dbp.query("ALTER TABLE notifications ADD COLUMN is_read TINYINT(1) NOT NULL DEFAULT 0 AFTER task_id");
  }
}

async function ensureRequestColumns() {
  const dbName = db.config.connectionConfig.database || "employeeslogin";
  const [columns] = await dbp.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME IN (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [dbName, "requests", "sender_id", "receiver_id", "workspace_id", "company_id", "title", "description", "request_title", "request_message", "created_at"]
  );
  const existing = new Set(columns.map(col => col.COLUMN_NAME));
  if (!existing.has("sender_id")) {
    await dbp.query("ALTER TABLE requests ADD COLUMN sender_id INT NULL AFTER id");
  }
  if (!existing.has("receiver_id")) {
    await dbp.query("ALTER TABLE requests ADD COLUMN receiver_id INT NULL AFTER sender_id");
  }
  if (!existing.has("workspace_id")) {
    await dbp.query("ALTER TABLE requests ADD COLUMN workspace_id INT NULL AFTER receiver_id");
  }
  if (!existing.has("company_id")) {
    await dbp.query("ALTER TABLE requests ADD COLUMN company_id INT NULL AFTER workspace_id");
  }
  if (!existing.has("title")) {
    await dbp.query("ALTER TABLE requests ADD COLUMN title VARCHAR(255) NULL AFTER manager_name");
  }
  if (!existing.has("description")) {
    await dbp.query("ALTER TABLE requests ADD COLUMN description TEXT NULL AFTER title");
  }
  if (!existing.has("request_title")) {
    await dbp.query("ALTER TABLE requests ADD COLUMN request_title VARCHAR(255) NULL AFTER title");
  }
  if (!existing.has("request_message")) {
    await dbp.query("ALTER TABLE requests ADD COLUMN request_message TEXT NULL AFTER request_title");
  }
  if (!existing.has("created_at")) {
    await dbp.query("ALTER TABLE requests ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP AFTER submitted_at");
  }
}

async function setupWorkspaceTables() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      source_id INT NULL,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NULL,
      role ENUM('employee','manager') NOT NULL,
      company_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY users_role_source_unique (role, source_id)
    )`,
    `CREATE TABLE IF NOT EXISTS workspaces (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_name VARCHAR(255) NOT NULL,
      company_name VARCHAR(255) NOT NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS workspace_members (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      user_id INT NOT NULL,
      role ENUM('employee','manager') NOT NULL,
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY workspace_member_unique (workspace_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      task_title VARCHAR(255) NULL,
      description TEXT NULL,
      task_description TEXT NULL,
      employee_id INT NOT NULL,
      assigned_employee INT NULL,
      manager_id INT NULL,
      status ENUM('pending','in_progress','review','completed') NOT NULL DEFAULT 'pending',
      board_column VARCHAR(50) NOT NULL DEFAULT 'Todo',
      attachment VARCHAR(255) NULL,
      priority ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
      due_date DATETIME NULL,
      deadline DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sender_id INT NOT NULL,
      receiver_id INT NULL,
      workspace_id INT NULL,
      company_id INT NULL,
      employee_id INT NOT NULL,
      employee_name VARCHAR(255) NOT NULL,
      manager_id INT NULL,
      manager_name VARCHAR(255) NULL,
      title VARCHAR(255) NULL,
      request_title VARCHAR(255) NULL,
      request_message TEXT NULL,
      description TEXT NULL,
      request_type VARCHAR(100) NOT NULL,
      details TEXT NOT NULL,
      priority ENUM('low','normal','high') NOT NULL DEFAULT 'normal',
      status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
      manager_note TEXT NULL,
      decided_by VARCHAR(255) NULL,
      decided_at DATETIME NULL,
      submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      role ENUM('employee','manager') NULL,
      title VARCHAR(255) NOT NULL,
      body TEXT NOT NULL,
      message TEXT NOT NULL,
      type VARCHAR(50) NOT NULL DEFAULT 'info',
      request_id INT NULL,
      task_id INT NULL,
      is_read TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS activity_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      actor_id INT NULL,
      actor_role VARCHAR(50) NOT NULL,
      action VARCHAR(120) NOT NULL,
      details TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS attendance (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      company_id INT NULL,
      check_in DATETIME NOT NULL,
      check_out DATETIME NULL,
      total_hours DECIMAL(8,2) NOT NULL DEFAULT 0,
      status ENUM('checked_in','checked_out') NOT NULL DEFAULT 'checked_in',
      is_late TINYINT(1) NOT NULL DEFAULT 0,
      attendance_date DATE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX attendance_employee_date (employee_id, attendance_date)
    )`,
    `CREATE TABLE IF NOT EXISTS leave_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      manager_id INT NULL,
      company_id INT NULL,
      leave_type ENUM('Sick Leave','Casual Leave','Emergency Leave') NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      reason TEXT NOT NULL,
      status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
      manager_note TEXT NULL,
      decided_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS departments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      company_id INT NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY department_company_name_unique (company_id, name)
    )`,
    `CREATE TABLE IF NOT EXISTS employee_departments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      department_id INT NOT NULL,
      assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY employee_department_unique (employee_id)
    )`,
    `CREATE TABLE IF NOT EXISTS files (
      id INT AUTO_INCREMENT PRIMARY KEY,
      uploader_id INT NOT NULL,
      uploader_role VARCHAR(50) NOT NULL,
      company_id INT NULL,
      original_name VARCHAR(255) NOT NULL,
      stored_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(120) NULL,
      size_bytes INT NULL,
      file_url VARCHAR(500) NOT NULL,
      shared_with_role ENUM('employee','manager','all') NOT NULL DEFAULT 'all',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS meetings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      room_id VARCHAR(120) NOT NULL UNIQUE,
      meeting_url VARCHAR(500) NOT NULL,
      created_by INT NOT NULL,
      company_id INT NULL,
      starts_at DATETIME NULL,
      history_summary TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS performance_reviews (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      manager_id INT NULL,
      company_id INT NULL,
      rating INT NOT NULL,
      feedback TEXT NULL,
      productivity_score INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS employee_profiles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      role ENUM('employee','manager','admin') NOT NULL,
      avatar_url VARCHAR(500) NULL,
      skills TEXT NULL,
      experience VARCHAR(255) NULL,
      contact_details TEXT NULL,
      about TEXT NULL,
      theme_preference VARCHAR(50) NOT NULL DEFAULT 'light',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY profile_user_role_unique (user_id, role)
    )`,
    `CREATE TABLE IF NOT EXISTS otp_codes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      otp_hash VARCHAR(255) NOT NULL,
      purpose VARCHAR(80) NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      room_id VARCHAR(255) NOT NULL,
      sender_id VARCHAR(100) NULL,
      sender_user_id INT NULL,
      sender_name VARCHAR(255) NOT NULL,
      sender_role VARCHAR(50) NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS employee_todos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT NULL,
      due_date DATETIME NULL,
      status ENUM('Pending', 'Working', 'Completed') NOT NULL DEFAULT 'Pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS employee_work_status (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL UNIQUE,
      current_status ENUM('Online', 'Working', 'Busy', 'On Break', 'Offline') NOT NULL DEFAULT 'Online',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
  ];

  for (const statement of statements) await dbp.query(statement);
  await dbp.query(
    "INSERT IGNORE INTO departments (name, company_id, created_by) VALUES ('HR', NULL, NULL), ('Development', NULL, NULL), ('Marketing', NULL, NULL), ('Sales', NULL, NULL)"
  );
  await ensureNotificationColumns();
  await ensureRequestColumns();
  console.log("Workspace tables ready");
}

setupWorkspaceTables().catch((err) => {
  console.error("Workspace table setup failed:", err.message);
});

async function ensureTaskColumns() {
  const dbName = db.config.connectionConfig.database || "employeeslogin";
  const [columns] = await dbp.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME IN (?, ?, ?, ?, ?, ?)",
    [dbName, "tasks", "board_column", "attachment", "task_title", "task_description", "assigned_employee", "deadline"]
  );
  const existing = new Set(columns.map(col => col.COLUMN_NAME));
  if (!existing.has("board_column")) {
    await dbp.query("ALTER TABLE tasks ADD COLUMN board_column VARCHAR(50) NOT NULL DEFAULT 'Todo'");
  }
  if (!existing.has("attachment")) {
    await dbp.query("ALTER TABLE tasks ADD COLUMN attachment VARCHAR(255) NULL");
  }
  if (!existing.has("task_title")) {
    await dbp.query("ALTER TABLE tasks ADD COLUMN task_title VARCHAR(255) NULL AFTER title");
  }
  if (!existing.has("task_description")) {
    await dbp.query("ALTER TABLE tasks ADD COLUMN task_description TEXT NULL AFTER description");
  }
  if (!existing.has("assigned_employee")) {
    await dbp.query("ALTER TABLE tasks ADD COLUMN assigned_employee INT NULL AFTER employee_id");
  }
  if (!existing.has("deadline")) {
    await dbp.query("ALTER TABLE tasks ADD COLUMN deadline DATETIME NULL AFTER due_date");
  }
  await dbp.query("ALTER TABLE tasks MODIFY COLUMN priority ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal'");
}

ensureTaskColumns().catch((err) => {
  console.error("Task column check failed:", err.message);
});

// ═══════════════════════════════════════════
//  JWT MIDDLEWARE
// ═══════════════════════════════════════════
function authMiddleware(req, res, next) {
  const header = req.headers["authorization"];
  if (!header) return res.status(401).json({ message: "No token provided." });
  const token = header.split(" ")[1];
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token." });
  }
}

// ═══════════════════════════════════════════
//  PAGE ROUTES
// ═══════════════════════════════════════════
// Root → always go to login first
app.get("/", (req, res) => {
  res.redirect("/info");
});

// Login page
app.get("/info", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "Infopage", "info.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "Loginpage", "login.html"));
});

// Dashboard (protected — served after login)
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "EmployeesWorkspace", "index.html"));
});

app.get("/manager", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "ManagerWorkspace", "manager.html"));
});

app.get("/team", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "teamsystem", "team.html"));
});

app.get("/call", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "Call", "call.html"));
});

// ═══════════════════════════════════════════
//  LOGIN API  —  POST /api/login
// ═══════════════════════════════════════════
app.post("/api/login", (req, res) => {
  const { id, email, password, role } = req.body;

  // ── Validation ───────────────────────────
  if (!id || !email || !password || !role) {
    return res.status(400).json({ message: "All fields are required." });
  }

  const numId       = parseInt(id, 10);
  const cleanPassword = String(password);

  if (isNaN(numId)) {
    return res.status(400).json({ message: "ID must be a number." });
  }

  const cleanEmail = String(email).trim().toLowerCase();

  // ── Employee Login ───────────────────────
  if (role === "employee") {
    db.query(
      "SELECT * FROM employees WHERE id = ? AND email = ?",
      [numId, cleanEmail],
      async (err, rows) => {
        if (err) {
          console.error("DB error (employee login):", err);
          return res.status(500).json({ message: "Server error. Please try again." });
        }
        if (rows.length === 0) {
          return res.status(401).json({ message: "Employee ID or email not found." });
        }
        const emp = rows[0];
        const passwordOk = await verifyPassword(cleanPassword, emp.password);
        if (!passwordOk) {
          return res.status(401).json({ message: "Wrong password." });
        }
        const token = jwt.sign(
          {
            id: emp.id,
            email: emp.email,
            name: emp.name || emp.email,
            role: "employee",
            company_id: emp.company_id || null,
            company_name: emp.company_name || null,
          },
          SECRET,
          { expiresIn: "8h" }
        );
        logActivity(emp.id, "employee", "user_login", "Employee logged in").catch(() => {});
        return res.json({
          success : true,
          message : "Login successful.",
          token,
          role    : "employee",
          name    : emp.name || emp.email,
          redirect: "/dashboard",
          company_id: emp.company_id || null,
          company_name: emp.company_name || null,
        });
      }
    );

  // ── Manager Login ────────────────────────
  } else if (role === "manager") {
    db.query(
      "SELECT * FROM managers WHERE id = ? AND email = ?",
      [numId, cleanEmail],
      async (err, rows) => {
        if (err) {
          console.error("DB error (manager login):", err);
          // If table doesn't exist yet, give clear message
          if (err.code === "ER_NO_SUCH_TABLE") {
            return res.status(500).json({
              message: "Manager database not set up yet. Run manager_setup.sql first.",
            });
          }
          return res.status(500).json({ message: "Server error. Please try again." });
        }
        if (rows.length === 0) {
          return res.status(401).json({ message: "Manager ID or email not found." });
        }
        const mgr = rows[0];
        const passwordOk = await verifyPassword(cleanPassword, mgr.password);
        if (!passwordOk) {
          return res.status(401).json({ message: "Wrong password." });
        }
        const token = jwt.sign(
          {
            id: mgr.id,
            email: mgr.email,
            name: mgr.name,
            role: "manager",
            company_id: mgr.company_id || null,
            company_name: mgr.company_name || null,
          },
          SECRET,
          { expiresIn: "8h" }
        );
        logActivity(mgr.id, "manager", "user_login", "Manager logged in").catch(() => {});
        return res.json({
          success : true,
          message : "Login successful.",
          token,
          role    : "manager",
          name    : mgr.name,
          redirect: "/manager",
          company_id: mgr.company_id || null,
          company_name: mgr.company_name || null,
        });
      }
    );

  // ── Invalid Role ─────────────────────────
  } else {
    return res.status(400).json({ message: "Invalid role selected." });
  }
});

// ═══════════════════════════════════════════
//  PROTECTED: Get logged-in user info
// ═══════════════════════════════════════════
app.get("/api/me", authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

function requireRole(role) {
  return (req, res, next) => {
    const allowed = Array.isArray(role) ? role : [role];
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({ message: "You do not have permission for this action." });
    }
    next();
  };
}

// Tasks assigned by managers and completed by employees.
app.get("/api/tasks", authMiddleware, async (req, res) => {
  try {
    const params = [];
    let sql = `
      SELECT t.*, e.name AS employee_name, m.name AS manager_name
      FROM tasks t
      LEFT JOIN employees e ON e.id = t.employee_id
      LEFT JOIN managers m ON m.id = t.manager_id
    `;

    if (req.user.role === "employee") {
      sql += " WHERE t.employee_id = ?";
      params.push(req.user.id);
    }

    sql += " ORDER BY FIELD(t.board_column, 'Todo', 'Preview', 'Code Review', 'Done'), t.created_at DESC";
    const [rows] = await dbp.query(sql, params);
    res.json({ tasks: rows });
  } catch (err) {
    console.error("Load tasks failed:", err);
    res.status(500).json({ message: "Could not load tasks." });
  }
});

app.post("/api/tasks", authMiddleware, requireRole("manager"), async (req, res) => {
  const { title, task_title, description, task_description, employee_id, assigned_employee, due_date, deadline, priority, board_column } = req.body;
  const taskTitle = String(title || task_title || "").trim();
  const taskDescription = String(description || task_description || "");
  const employeeId = Number(employee_id || assigned_employee);
  if (!taskTitle || !employeeId) return res.status(400).json({ message: "Task title and employee are required." });

  try {
    const initialColumn = board_column || "Todo";
    const [result] = await dbp.query(
      `INSERT INTO tasks
       (title, task_title, description, task_description, employee_id, assigned_employee, manager_id, due_date, deadline, priority, board_column)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [taskTitle, taskTitle, taskDescription, taskDescription, employeeId, employeeId, req.user.id, due_date || deadline || null, deadline || due_date || null, priority || "normal", initialColumn]
    );
    const [rows] = await dbp.query("SELECT * FROM tasks WHERE id = ?", [result.insertId]);
    const task = rows[0];
    const [employeeRows] = await dbp.query("SELECT email FROM employees WHERE id = ?", [employeeId]);
    const notification = await createNotification(
      employee_id,
      "employee",
      "New task assigned",
      `${req.user.name} assigned: ${taskTitle}`,
      "task",
      null,
      task.id
    );
    await logActivity(req.user.id, "manager", "task_created", `Assigned "${taskTitle}" to employee #${employeeId}`);
    await sendEmail(employeeRows[0]?.email, "New FlowDesk task assigned", `${req.user.name} assigned you a task: ${taskTitle}`);
    emitToUserId(employeeId, "notification:new", notification);
    emitToUserId(employeeId, "task:changed", task);
    res.status(201).json({ task });
  } catch (err) {
    console.error("Create task failed:", err);
    res.status(500).json({ message: "Could not create task." });
  }
});

app.patch("/api/tasks/:id", authMiddleware, async (req, res) => {
  const taskId = Number(req.params.id);
  const { status, title, description, due_date, priority, board_column, attachment } = req.body;
  const allowedStatuses = new Set(["pending", "in_progress", "completed"]);
  const allowedBoardColumns = new Set(["Todo", "Preview", "Code Review", "Done"]);
  if (status && !allowedStatuses.has(status)) return res.status(400).json({ message: "Invalid task status." });
  if (board_column && !allowedBoardColumns.has(board_column)) return res.status(400).json({ message: "Invalid board column." });

  try {
    const [existingRows] = await dbp.query("SELECT * FROM tasks WHERE id = ?", [taskId]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ message: "Task not found." });
    if (req.user.role === "employee" && String(existing.employee_id) !== String(req.user.id)) {
      return res.status(403).json({ message: "You can only update your own tasks." });
    }

    await dbp.query(
      `UPDATE tasks
       SET title = COALESCE(?, title),
           task_title = COALESCE(?, task_title),
           description = COALESCE(?, description),
           task_description = COALESCE(?, task_description),
           due_date = COALESCE(?, due_date),
           deadline = COALESCE(?, deadline),
           priority = COALESCE(?, priority),
           board_column = COALESCE(?, board_column),
           attachment = COALESCE(?, attachment),
           status = COALESCE(?, status)
       WHERE id = ?`,
      [title || null, title || null, description || null, description || null, due_date || null, due_date || null, priority || null, board_column || null, attachment || null, status || null, taskId]
    );
    const [rows] = await dbp.query("SELECT * FROM tasks WHERE id = ?", [taskId]);
    const task = rows[0];
    await logActivity(req.user.id, req.user.role, "task_updated", `Task #${taskId} changed to ${task.status}`);

    if (req.user.role === "employee") {
      const notification = await createNotification(
        task.manager_id,
        "manager",
        "Task updated",
        `${req.user.name} changed "${task.title}" to ${task.status}`,
        "task",
        null,
        task.id
      );
      emitToUserId(task.manager_id, "notification:new", notification);
    }

    emitToUserId(task.employee_id, "task:changed", task);
    emitToRole("manager", "task:changed", task);
    res.json({ task });
  } catch (err) {
    console.error("Update task failed:", err);
    res.status(500).json({ message: "Could not update task." });
  }
});

app.delete("/api/tasks/:id", authMiddleware, requireRole("manager"), async (req, res) => {
  try {
    const [rows] = await dbp.query("SELECT * FROM tasks WHERE id = ?", [req.params.id]);
    const task = rows[0];
    if (!task) return res.status(404).json({ message: "Task not found." });
    await dbp.query("DELETE FROM tasks WHERE id = ?", [req.params.id]);
    await logActivity(req.user.id, "manager", "task_deleted", `Deleted task #${req.params.id}`);
    emitToUserId(task.employee_id, "task:deleted", { id: Number(req.params.id) });
    emitToRole("manager", "task:deleted", { id: Number(req.params.id) });
    res.json({ success: true });
  } catch (err) {
    console.error("Delete task failed:", err);
    res.status(500).json({ message: "Could not delete task." });
  }
});

app.get("/api/employees", authMiddleware, requireRole("manager"), async (req, res) => {
  try {
    const [employees] = await dbp.query("SELECT id, name, email FROM employees ORDER BY name, id");
    res.json({ employees });
  } catch (err) {
    console.error("Load employees failed:", err);
    res.status(500).json({ message: "Could not load employees." });
  }
});

// Employee requests and manager approvals.
app.get("/api/requests", authMiddleware, async (req, res) => {
  try {
    const params = [];
    let sql = `SELECT * FROM requests`;
    if (req.user.role === "employee") {
      sql += ` WHERE employee_id = ?`;
      params.push(req.user.id);
    } else if (req.user.role === "manager") {
      sql += ` WHERE company_id = ?`;
      params.push(req.user.company_id || 0);
    }
    sql += ` ORDER BY FIELD(status, 'pending', 'approved', 'rejected'), submitted_at DESC`;
    const [requests] = await dbp.query(sql, params);
    res.json({ requests });
  } catch (err) {
    console.error("Load requests failed:", err);
    res.status(500).json({ message: "Could not load requests." });
  }
});

app.get("/api/requests/manager/:managerId", authMiddleware, requireRole("manager"), async (req, res) => {
  if (String(req.user.id) !== String(req.params.managerId)) {
    return res.status(403).json({ message: "You can only fetch your own manager requests." });
  }
  try {
    const [requests] = await dbp.query(
      `SELECT * FROM requests WHERE company_id = ? ORDER BY FIELD(status, 'pending', 'approved', 'rejected'), submitted_at DESC`,
      [req.user.company_id || 0]
    );
    res.json({ requests });
  } catch (err) {
    console.error("Load manager requests failed:", err);
    res.status(500).json({ message: "Could not load manager requests." });
  }
});

async function createEmployeeRequest(req, res) {
  const { title, request_title, description, request_message, request_type, details, priority, manager_id } = req.body;
  const requestType = String(request_type || title || request_title || "").trim();
  const reqTitle = String(request_title || title || requestType).trim();
  const reqDesc = String(request_message || description || details || "").trim();
  if (!requestType || !reqDesc) return res.status(400).json({ message: "Request title and message are required." });

  try {
    const [managerRows] = manager_id
      ? await dbp.query(
          "SELECT id, name FROM managers WHERE id = ? AND company_id = ? LIMIT 1",
          [manager_id, req.user.company_id || 0]
        )
      : await dbp.query(
          "SELECT id, name FROM managers WHERE company_id = ? ORDER BY id LIMIT 1",
          [req.user.company_id || 0]
        );
    const selectedManagerId = managerRows[0]?.id || null;
    const selectedManagerName = managerRows[0]?.name || null;
    const [result] = await dbp.query(
      `INSERT INTO requests
       (sender_id, receiver_id, workspace_id, company_id, employee_id, employee_name, manager_id, manager_name, title, request_title, request_message, description, request_type, details, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        selectedManagerId,
        req.user.company_id || null,
        req.user.company_id || null,
        req.user.id,
        req.user.name || req.user.email || "Employee",
        selectedManagerId,
        selectedManagerName,
        reqTitle,
        reqTitle,
        reqDesc,
        reqDesc,
        requestType,
        reqDesc,
        priority || "normal"
      ]
    );
    const [rows] = await dbp.query("SELECT * FROM requests WHERE id = ?", [result.insertId]);
    const request = rows[0];
    await logActivity(req.user.id, "employee", "request_created", `${requestType} request submitted`);
    await createNotificationsForCompanyManagers(req.user.company_id, req.user.name || req.user.email || "Employee", reqTitle, reqDesc, request.id);
    emitToCompany("manager", req.user.company_id, "request:new", request);
    res.status(201).json({ request });
  } catch (err) {
    console.error("Create request failed:", err);
    res.status(500).json({ message: "Could not send request." });
  }
}

app.post("/api/requests/send", authMiddleware, requireRole("employee"), createEmployeeRequest);
app.post("/api/requests", authMiddleware, requireRole("employee"), createEmployeeRequest);

async function handleRequestDecision(req, res, approved) {
  let { status, note, manager_response } = req.body;
  if (typeof status === "string") status = status.toLowerCase();
  if (typeof approved !== "boolean") {
    if (status === "approved") approved = true;
    else if (status === "rejected") approved = false;
    else return res.status(400).json({ message: "Status must be approved or rejected." });
  }
  status = approved ? "approved" : "rejected";
  const managerNote = manager_response || note || null;

  try {
    const [existingRows] = await dbp.query("SELECT * FROM requests WHERE id = ?", [req.params.id]);
    const request = existingRows[0];
    if (!request) return res.status(404).json({ message: "Request not found." });
    if (String(request.company_id) !== String(req.user.company_id)) {
      return res.status(403).json({ message: "You cannot approve requests from another company." });
    }

    await dbp.query(
      `UPDATE requests SET status = ?, manager_id = ?, manager_name = ?, manager_note = ?, decided_by = ?, decided_at = NOW() WHERE id = ?`,
      [status, req.user.id, req.user.name || null, managerNote, req.user.name || null, req.params.id]
    );
    const [updatedRows] = await dbp.query("SELECT * FROM requests WHERE id = ?", [req.params.id]);
    const updatedRequest = updatedRows[0];
    const notification = await createNotificationForUser(
      updatedRequest.employee_id,
      "employee",
      `Request ${status}`,
      `Your request has been ${status} by manager.`,
      status,
      updatedRequest.id,
      null
    );
    await logActivity(req.user.id, "manager", `request_${status}`, `Request #${updatedRequest.id} ${status}`);
    emitToUserId(updatedRequest.employee_id, "request:decision_result", updatedRequest);
    emitToUserId(updatedRequest.employee_id, status === "approved" ? "request_accepted" : "request_rejected", updatedRequest);
    emitToCompany("manager", req.user.company_id, "request:changed", updatedRequest);
    res.json({ request: updatedRequest });
  } catch (err) {
    console.error("Update request failed:", err);
    res.status(500).json({ message: "Could not update request." });
  }
}

app.patch("/api/requests/:id", authMiddleware, requireRole("manager"), async (req, res) => handleRequestDecision(req, res, typeof req.body.approved === "boolean" ? req.body.approved : null));
app.put("/api/requests/:id/accept", authMiddleware, requireRole("manager"), async (req, res) => handleRequestDecision(req, res, true));
app.put("/api/requests/:id/reject", authMiddleware, requireRole("manager"), async (req, res) => handleRequestDecision(req, res, false));

app.get("/api/notifications", authMiddleware, async (req, res) => {
  try {
    const [notifications] = await dbp.query(
      `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    const unreadCount = notifications.filter(n => !n.is_read).length;
    res.json({ notifications, unread_count: unreadCount });
  } catch (err) {
    console.error("Load notifications failed:", err);
    res.status(500).json({ message: "Could not load notifications." });
  }
});

app.get("/api/notifications/:userId", authMiddleware, async (req, res) => {
  const userId = Number(req.params.userId);
  if (req.user.id !== userId) {
    return res.status(403).json({ message: "You can only access your own notifications." });
  }
  try {
    const [notifications] = await dbp.query(
      `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
      [userId]
    );
    const unreadCount = notifications.filter(n => !n.is_read).length;
    res.json({ notifications, unread_count: unreadCount });
  } catch (err) {
    console.error("Load user notifications failed:", err);
    res.status(500).json({ message: "Could not load notifications." });
  }
});

app.patch("/api/notifications/read", authMiddleware, async (req, res) => {
  try {
    await dbp.query("UPDATE notifications SET is_read = 1 WHERE user_id = ?", [req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Could not update notifications." });
  }
});

app.patch("/api/notifications/:id/read", authMiddleware, async (req, res) => {
  try {
    await dbp.query("UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Could not update notification." });
  }
});

app.get("/api/activity-logs", authMiddleware, requireRole("manager"), async (req, res) => {
  try {
    const [logs] = await dbp.query("SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 100");
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ message: "Could not load activity logs." });
  }
});

app.post("/api/attendance/check-in", authMiddleware, requireRole("employee"), async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [openRows] = await dbp.query(
      "SELECT * FROM attendance WHERE employee_id = ? AND attendance_date = ? AND status = 'checked_in' LIMIT 1",
      [req.user.id, today]
    );
    if (openRows.length) return res.status(409).json({ message: "You are already checked in.", attendance: openRows[0] });
    const hour = new Date().getHours();
    const isLate = hour >= 10 ? 1 : 0;
    const [result] = await dbp.query(
      "INSERT INTO attendance (employee_id, company_id, check_in, attendance_date, is_late) VALUES (?, ?, NOW(), CURDATE(), ?)",
      [req.user.id, req.user.company_id || null, isLate]
    );
    const [rows] = await dbp.query("SELECT * FROM attendance WHERE id = ?", [result.insertId]);
    await logActivity(req.user.id, "employee", "attendance_check_in", "Checked in");
    emitToCompany("manager", req.user.company_id, "attendance:updated", rows[0]);
    res.status(201).json({ attendance: rows[0] });
  } catch (err) {
    console.error("Check in failed:", err);
    res.status(500).json({ message: "Could not check in." });
  }
});

app.post("/api/attendance/check-out", authMiddleware, requireRole("employee"), async (req, res) => {
  try {
    const [openRows] = await dbp.query(
      "SELECT * FROM attendance WHERE employee_id = ? AND status = 'checked_in' ORDER BY check_in DESC LIMIT 1",
      [req.user.id]
    );
    if (!openRows.length) return res.status(404).json({ message: "No active check-in found." });
    const attendance = openRows[0];
    await dbp.query(
      "UPDATE attendance SET check_out = NOW(), total_hours = ROUND(TIMESTAMPDIFF(MINUTE, check_in, NOW()) / 60, 2), status = 'checked_out' WHERE id = ?",
      [attendance.id]
    );
    const [rows] = await dbp.query("SELECT * FROM attendance WHERE id = ?", [attendance.id]);
    await logActivity(req.user.id, "employee", "attendance_check_out", "Checked out");
    emitToCompany("manager", req.user.company_id, "attendance:updated", rows[0]);
    res.json({ attendance: rows[0] });
  } catch (err) {
    console.error("Check out failed:", err);
    res.status(500).json({ message: "Could not check out." });
  }
});

app.get("/api/attendance", authMiddleware, async (req, res) => {
  try {
    const { month } = req.query;
    const monthFilter = month || new Date().toISOString().slice(0, 7);
    const params = [];
    let sql = `SELECT a.*, e.name AS employee_name, e.email
               FROM attendance a
               LEFT JOIN employees e ON e.id = a.employee_id
               WHERE DATE_FORMAT(a.attendance_date, '%Y-%m') = ?`;
    params.push(monthFilter);
    if (req.user.role === "employee") {
      sql += " AND a.employee_id = ?";
      params.push(req.user.id);
    } else {
      sql += " AND (a.company_id = ? OR a.company_id IS NULL)";
      params.push(req.user.company_id || 0);
    }
    sql += " ORDER BY a.attendance_date DESC, a.check_in DESC";
    const [attendance] = await dbp.query(sql, params);
    const totalHours = attendance.reduce((sum, row) => sum + Number(row.total_hours || 0), 0);
    const lateCount = attendance.filter(row => row.is_late).length;
    res.json({ attendance, summary: { days: attendance.length, total_hours: Number(totalHours.toFixed(2)), late_entries: lateCount } });
  } catch (err) {
    console.error("Load attendance failed:", err);
    res.status(500).json({ message: "Could not load attendance." });
  }
});

app.post("/api/leave-requests", authMiddleware, requireRole("employee"), async (req, res) => {
  const { leave_type, start_date, end_date, reason } = req.body;
  const allowed = new Set(["Sick Leave", "Casual Leave", "Emergency Leave"]);
  if (!allowed.has(leave_type) || !start_date || !end_date || !reason?.trim()) {
    return res.status(400).json({ message: "Leave type, dates, and reason are required." });
  }
  try {
    const [result] = await dbp.query(
      "INSERT INTO leave_requests (employee_id, company_id, leave_type, start_date, end_date, reason) VALUES (?, ?, ?, ?, ?, ?)",
      [req.user.id, req.user.company_id || null, leave_type, start_date, end_date, reason.trim()]
    );
    const [rows] = await dbp.query("SELECT lr.*, e.name AS employee_name FROM leave_requests lr LEFT JOIN employees e ON e.id = lr.employee_id WHERE lr.id = ?", [result.insertId]);
    await logActivity(req.user.id, "employee", "leave_requested", `${leave_type} requested`);
    await createNotificationsForCompanyManagers(req.user.company_id, req.user.name || "Employee", leave_type, reason.trim(), null);
    emitToCompany("manager", req.user.company_id, "leave:new", rows[0]);
    res.status(201).json({ leave: rows[0] });
  } catch (err) {
    console.error("Create leave failed:", err);
    res.status(500).json({ message: "Could not apply for leave." });
  }
});

app.get("/api/leave-requests", authMiddleware, async (req, res) => {
  try {
    const params = [];
    let sql = `SELECT lr.*, e.name AS employee_name, m.name AS manager_name
               FROM leave_requests lr
               LEFT JOIN employees e ON e.id = lr.employee_id
               LEFT JOIN managers m ON m.id = lr.manager_id`;
    if (req.user.role === "employee") {
      sql += " WHERE lr.employee_id = ?";
      params.push(req.user.id);
    } else {
      sql += " WHERE lr.company_id = ?";
      params.push(req.user.company_id || 0);
    }
    sql += " ORDER BY FIELD(lr.status, 'pending','approved','rejected'), lr.created_at DESC";
    const [leave_requests] = await dbp.query(sql, params);
    res.json({ leave_requests });
  } catch (err) {
    res.status(500).json({ message: "Could not load leave requests." });
  }
});

app.patch("/api/leave-requests/:id", authMiddleware, requireRole("manager"), async (req, res) => {
  const status = String(req.body.status || "").toLowerCase();
  if (!["approved", "rejected"].includes(status)) return res.status(400).json({ message: "Status must be approved or rejected." });
  try {
    const [existingRows] = await dbp.query("SELECT * FROM leave_requests WHERE id = ? AND company_id = ?", [req.params.id, req.user.company_id || 0]);
    if (!existingRows.length) return res.status(404).json({ message: "Leave request not found." });
    await dbp.query(
      "UPDATE leave_requests SET status = ?, manager_id = ?, manager_note = ?, decided_at = NOW() WHERE id = ?",
      [status, req.user.id, req.body.manager_note || null, req.params.id]
    );
    const [rows] = await dbp.query("SELECT * FROM leave_requests WHERE id = ?", [req.params.id]);
    const leave = rows[0];
    const [employeeRows] = await dbp.query("SELECT email FROM employees WHERE id = ?", [leave.employee_id]);
    const note = await createNotificationForUser(leave.employee_id, "employee", `Leave ${status}`, `Your leave request has been ${status}.`, `leave_${status}`, leave.id, null);
    await sendEmail(employeeRows[0]?.email, `Leave ${status}`, `Your FlowDesk leave request has been ${status}.`);
    await logActivity(req.user.id, "manager", `leave_${status}`, `Leave #${leave.id} ${status}`);
    emitToUserId(leave.employee_id, "notification:new", note);
    emitToUserId(leave.employee_id, "leave:updated", leave);
    emitToCompany("manager", req.user.company_id, "leave:updated", leave);
    res.json({ leave });
  } catch (err) {
    res.status(500).json({ message: "Could not update leave request." });
  }
});

app.get("/api/performance", authMiddleware, async (req, res) => {
  try {
    const params = [];
    let sql = `SELECT pr.*, e.name AS employee_name, m.name AS manager_name
               FROM performance_reviews pr
               LEFT JOIN employees e ON e.id = pr.employee_id
               LEFT JOIN managers m ON m.id = pr.manager_id`;
    if (req.user.role === "employee") {
      sql += " WHERE pr.employee_id = ?";
      params.push(req.user.id);
    } else {
      sql += " WHERE pr.company_id = ?";
      params.push(req.user.company_id || 0);
    }
    sql += " ORDER BY pr.created_at DESC";
    const [reviews] = await dbp.query(sql, params);
    const [taskStats] = await dbp.query(
      `SELECT employee_id,
              SUM(status = 'completed') AS completed_tasks,
              COUNT(*) AS total_tasks
       FROM tasks
       ${req.user.role === "employee" ? "WHERE employee_id = ?" : "WHERE manager_id = ?"}
       GROUP BY employee_id`,
      [req.user.id]
    );
    res.json({ reviews, task_stats: taskStats });
  } catch (err) {
    res.status(500).json({ message: "Could not load performance data." });
  }
});

app.post("/api/performance", authMiddleware, requireRole("manager"), async (req, res) => {
  const employeeId = Number(req.body.employee_id);
  const rating = Number(req.body.rating);
  if (!employeeId || !rating || rating < 1 || rating > 5) return res.status(400).json({ message: "Employee and rating 1-5 are required." });
  try {
    const [tasks] = await dbp.query("SELECT status FROM tasks WHERE employee_id = ?", [employeeId]);
    const completed = tasks.filter(task => task.status === "completed").length;
    const productivity = tasks.length ? Math.round((completed / tasks.length) * 100) : rating * 20;
    const [result] = await dbp.query(
      "INSERT INTO performance_reviews (employee_id, manager_id, company_id, rating, feedback, productivity_score) VALUES (?, ?, ?, ?, ?, ?)",
      [employeeId, req.user.id, req.user.company_id || null, rating, req.body.feedback || "", productivity]
    );
    const [rows] = await dbp.query("SELECT * FROM performance_reviews WHERE id = ?", [result.insertId]);
    const note = await createNotificationForUser(employeeId, "employee", "New performance feedback", `Manager rated you ${rating}/5.`, "performance", null, null);
    await logActivity(req.user.id, "manager", "performance_reviewed", `Reviewed employee #${employeeId}`);
    emitToUserId(employeeId, "notification:new", note);
    emitToUserId(employeeId, "performance:updated", rows[0]);
    res.status(201).json({ review: rows[0] });
  } catch (err) {
    res.status(500).json({ message: "Could not save performance review." });
  }
});

app.get("/api/departments", authMiddleware, async (req, res) => {
  try {
    const [departments] = await dbp.query(
      `SELECT d.*, COUNT(ed.employee_id) AS employee_count
       FROM departments d
       LEFT JOIN employee_departments ed ON ed.department_id = d.id
       WHERE d.company_id = ? OR d.company_id IS NULL
       GROUP BY d.id
       ORDER BY d.name`,
      [req.user.company_id || 0]
    );
    res.json({ departments });
  } catch (err) {
    res.status(500).json({ message: "Could not load departments." });
  }
});

app.post("/api/departments", authMiddleware, requireRole(["manager", "admin"]), async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ message: "Department name is required." });
  try {
    const [result] = await dbp.query("INSERT INTO departments (name, company_id, created_by) VALUES (?, ?, ?)", [name, req.user.company_id || null, req.user.id]);
    const [rows] = await dbp.query("SELECT * FROM departments WHERE id = ?", [result.insertId]);
    await logActivity(req.user.id, req.user.role, "department_created", name);
    res.status(201).json({ department: rows[0] });
  } catch (err) {
    res.status(500).json({ message: "Could not create department." });
  }
});

app.post("/api/departments/:id/assign", authMiddleware, requireRole(["manager", "admin"]), async (req, res) => {
  const employeeId = Number(req.body.employee_id);
  if (!employeeId) return res.status(400).json({ message: "Employee is required." });
  try {
    await dbp.query(
      "INSERT INTO employee_departments (employee_id, department_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE department_id = VALUES(department_id)",
      [employeeId, req.params.id]
    );
    await logActivity(req.user.id, req.user.role, "department_assigned", `Employee #${employeeId} assigned to department #${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Could not assign department." });
  }
});

app.get("/api/files", authMiddleware, async (req, res) => {
  try {
    const [files] = await dbp.query(
      "SELECT * FROM files WHERE company_id = ? AND (shared_with_role = ? OR shared_with_role = 'all' OR uploader_id = ?) ORDER BY created_at DESC",
      [req.user.company_id || 0, req.user.role, req.user.id]
    );
    res.json({ files });
  } catch (err) {
    res.status(500).json({ message: "Could not load files." });
  }
});

app.post("/api/files/upload", authMiddleware, (req, res, next) => {
  if (!upload) return res.status(503).json({ message: "Install multer to enable file uploads: npm install" });
  upload.single("file")(req, res, next);
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "File is required." });
  try {
    const fileUrl = `/uploads/${req.file.filename}`;
    const [result] = await dbp.query(
      "INSERT INTO files (uploader_id, uploader_role, company_id, original_name, stored_name, mime_type, size_bytes, file_url, shared_with_role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [req.user.id, req.user.role, req.user.company_id || null, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, fileUrl, req.body.shared_with_role || "all"]
    );
    const [rows] = await dbp.query("SELECT * FROM files WHERE id = ?", [result.insertId]);
    await logActivity(req.user.id, req.user.role, "file_uploaded", req.file.originalname);
    emitToCompany("manager", req.user.company_id, "file:uploaded", rows[0]);
    emitToCompany("employee", req.user.company_id, "file:uploaded", rows[0]);
    res.status(201).json({ file: rows[0] });
  } catch (err) {
    res.status(500).json({ message: "Could not save file metadata." });
  }
});

app.get("/api/meetings", authMiddleware, async (req, res) => {
  try {
    const [meetings] = await dbp.query("SELECT * FROM meetings WHERE company_id = ? ORDER BY COALESCE(starts_at, created_at) DESC", [req.user.company_id || 0]);
    res.json({ meetings });
  } catch (err) {
    res.status(500).json({ message: "Could not load meetings." });
  }
});

app.post("/api/meetings", authMiddleware, requireRole(["manager", "admin"]), async (req, res) => {
  const title = String(req.body.title || "Team Meeting").trim();
  const roomId = `flowdesk-${req.user.company_id || "team"}-${Date.now().toString(36)}`;
  const meetingUrl = `https://meet.jit.si/${roomId}`;
  try {
    const [result] = await dbp.query(
      "INSERT INTO meetings (title, room_id, meeting_url, created_by, company_id, starts_at) VALUES (?, ?, ?, ?, ?, ?)",
      [title, roomId, meetingUrl, req.user.id, req.user.company_id || null, req.body.starts_at || null]
    );
    const [rows] = await dbp.query("SELECT * FROM meetings WHERE id = ?", [result.insertId]);
    await logActivity(req.user.id, req.user.role, "meeting_created", title);
    emitToCompany("employee", req.user.company_id, "meeting:new", rows[0]);
    emitToCompany("manager", req.user.company_id, "meeting:new", rows[0]);
    res.status(201).json({ meeting: rows[0] });
  } catch (err) {
    res.status(500).json({ message: "Could not create meeting." });
  }
});

app.get("/api/calendar/events", authMiddleware, async (req, res) => {
  try {
    const [tasks] = await dbp.query("SELECT id, title, due_date FROM tasks WHERE (employee_id = ? OR manager_id = ?) AND due_date IS NOT NULL", [req.user.id, req.user.id]);
    const [leaves] = await dbp.query("SELECT id, leave_type, start_date, end_date, status FROM leave_requests WHERE employee_id = ? OR company_id = ?", [req.user.id, req.user.company_id || 0]);
    const [meetings] = await dbp.query("SELECT id, title, starts_at, meeting_url FROM meetings WHERE company_id = ?", [req.user.company_id || 0]);
    const events = [
      ...tasks.map(t => ({ type: "task", title: t.title, start: t.due_date, id: t.id })),
      ...leaves.map(l => ({ type: "leave", title: `${l.leave_type} (${l.status})`, start: l.start_date, end: l.end_date, id: l.id })),
      ...meetings.map(m => ({ type: "meeting", title: m.title, start: m.starts_at, url: m.meeting_url, id: m.id }))
    ];
    res.json({ events });
  } catch (err) {
    res.status(500).json({ message: "Could not load calendar events." });
  }
});

app.get("/api/profile", authMiddleware, async (req, res) => {
  try {
    const [rows] = await dbp.query("SELECT * FROM employee_profiles WHERE user_id = ? AND role = ?", [req.user.id, req.user.role]);
    res.json({ profile: rows[0] || null });
  } catch (err) {
    res.status(500).json({ message: "Could not load profile." });
  }
});

app.put("/api/profile", authMiddleware, async (req, res) => {
  try {
    await dbp.query(
      `INSERT INTO employee_profiles (user_id, role, skills, experience, contact_details, about, theme_preference)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE skills = VALUES(skills), experience = VALUES(experience), contact_details = VALUES(contact_details), about = VALUES(about), theme_preference = VALUES(theme_preference)`,
      [req.user.id, req.user.role, req.body.skills || "", req.body.experience || "", req.body.contact_details || "", req.body.about || "", req.body.theme_preference || "light"]
    );
    const [rows] = await dbp.query("SELECT * FROM employee_profiles WHERE user_id = ? AND role = ?", [req.user.id, req.user.role]);
    res.json({ profile: rows[0] });
  } catch (err) {
    res.status(500).json({ message: "Could not update profile." });
  }
});

app.get("/api/analytics", authMiddleware, requireRole(["manager", "admin"]), async (req, res) => {
  try {
    const [[taskStats]] = await dbp.query("SELECT COUNT(*) AS total, SUM(status = 'completed') AS completed FROM tasks WHERE manager_id = ?", [req.user.id]);
    const [[attendanceStats]] = await dbp.query("SELECT COUNT(*) AS entries, SUM(is_late) AS late_entries, ROUND(SUM(total_hours), 2) AS total_hours FROM attendance WHERE company_id = ?", [req.user.company_id || 0]);
    const [[leaveStats]] = await dbp.query("SELECT COUNT(*) AS total, SUM(status = 'approved') AS approved, SUM(status = 'rejected') AS rejected FROM leave_requests WHERE company_id = ?", [req.user.company_id || 0]);
    const [departmentStats] = await dbp.query(
      `SELECT d.name, COUNT(ed.employee_id) AS employee_count
       FROM departments d LEFT JOIN employee_departments ed ON ed.department_id = d.id
       WHERE d.company_id = ? OR d.company_id IS NULL
       GROUP BY d.id ORDER BY d.name`,
      [req.user.company_id || 0]
    );
    res.json({ task_stats: taskStats, attendance_stats: attendanceStats, leave_stats: leaveStats, department_stats: departmentStats });
  } catch (err) {
    res.status(500).json({ message: "Could not load analytics." });
  }
});

app.post("/api/ai/task-suggestions", authMiddleware, async (req, res) => {
  const context = String(req.body.context || "").toLowerCase();
  const suggestions = [
    context.includes("report") ? "Prepare a draft report and attach supporting files" : "Break the work into a planning task and an execution task",
    context.includes("bug") ? "Create a priority bug fix task with reproduction notes" : "Schedule a quick team sync for blockers",
    "Set a deadline and assign an owner before the next standup"
  ];
  res.json({ suggestions });
});

app.post("/api/ai/chat", authMiddleware, async (req, res) => {
  const message = String(req.body.message || "");
  res.json({ reply: `FlowDesk Assistant: I noted "${message}". Suggested next step: create a task, assign an owner, and track it in the dashboard.` });
});

app.post("/api/ai/meeting-summary", authMiddleware, async (req, res) => {
  const notes = String(req.body.notes || "");
  const summary = notes.split(/[.\n]/).map(s => s.trim()).filter(Boolean).slice(0, 3);
  res.json({ summary: summary.length ? summary : ["No meeting notes provided."], action_items: ["Confirm owners", "Set deadlines", "Share the summary with the team"] });
});

app.get("/api/ai/productivity", authMiddleware, async (req, res) => {
  try {
    const [tasks] = await dbp.query("SELECT status FROM tasks WHERE employee_id = ?", [req.user.id]);
    const completed = tasks.filter(task => task.status === "completed").length;
    const score = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;
    res.json({ score, insight: score >= 70 ? "Strong completion trend." : "Focus on finishing in-progress tasks before starting new ones." });
  } catch {
    res.json({ score: 0, insight: "Not enough data yet." });
  }
});

app.post("/api/security/request-otp", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ message: "Email is required." });
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const hash = crypto.createHash("sha256").update(otp).digest("hex");
  await dbp.query("INSERT INTO otp_codes (email, otp_hash, purpose, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))", [email, hash, req.body.purpose || "login"]);
  await sendEmail(email, "FlowDesk OTP", `Your FlowDesk OTP is ${otp}. It expires in 10 minutes.`);
  res.json({ success: true, message: "OTP sent if email delivery is configured." });
});

app.post("/api/security/verify-otp", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const hash = crypto.createHash("sha256").update(String(req.body.otp || "")).digest("hex");
  const [rows] = await dbp.query("SELECT * FROM otp_codes WHERE email = ? AND otp_hash = ? AND used_at IS NULL AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1", [email, hash]);
  if (!rows.length) return res.status(400).json({ message: "Invalid or expired OTP." });
  await dbp.query("UPDATE otp_codes SET used_at = NOW() WHERE id = ?", [rows[0].id]);
  res.json({ success: true });
});

app.get("/api/admin/users", authMiddleware, requireRole(["manager", "admin"]), async (req, res) => {
  try {
    const [employees] = await dbp.query("SELECT id, name, email, company_id, 'employee' AS role FROM employees WHERE company_id = ?", [req.user.company_id || 0]);
    const [managers] = await dbp.query("SELECT id, name, email, company_id, 'manager' AS role FROM managers WHERE company_id = ?", [req.user.company_id || 0]);
    res.json({ users: [...employees, ...managers] });
  } catch (err) {
    res.status(500).json({ message: "Could not load users." });
  }
});

app.get("/api/messages/:roomId", authMiddleware, async (req, res) => {
  try {
    const [messages] = await dbp.query(
      "SELECT id, room_id, sender_id, sender_user_id, sender_name, sender_role, message, created_at FROM messages WHERE room_id = ? ORDER BY created_at ASC LIMIT 100",
      [req.params.roomId]
    );
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ message: "Could not load messages." });
  }
});

// ═══════════════════════════════════════════
//  TODO APIS
// ═══════════════════════════════════════════
app.get("/api/todos", authMiddleware, requireRole("employee"), async (req, res) => {
  try {
    const [todos] = await dbp.query("SELECT * FROM employee_todos WHERE employee_id = ? ORDER BY created_at DESC", [req.user.id]);
    res.json({ todos });
  } catch (err) {
    console.error("Load todos failed:", err);
    res.status(500).json({ message: "Could not load todos." });
  }
});

app.post("/api/todos", authMiddleware, requireRole("employee"), async (req, res) => {
  const { title, description, due_date, status } = req.body;
  if (!title) return res.status(400).json({ message: "Todo title is required." });

  try {
    const [result] = await dbp.query(
      "INSERT INTO employee_todos (employee_id, title, description, due_date, status) VALUES (?, ?, ?, ?, ?)",
      [req.user.id, title.trim(), description || null, due_date || null, status || 'Pending']
    );
    const [rows] = await dbp.query("SELECT * FROM employee_todos WHERE id = ?", [result.insertId]);
    res.status(201).json({ todo: rows[0] });
  } catch (err) {
    console.error("Create todo failed:", err);
    res.status(500).json({ message: "Could not create todo." });
  }
});

app.patch("/api/todos/:id", authMiddleware, requireRole("employee"), async (req, res) => {
  const todoId = Number(req.params.id);
  const { title, description, due_date, status } = req.body;
  
  try {
    const [existingRows] = await dbp.query("SELECT * FROM employee_todos WHERE id = ? AND employee_id = ?", [todoId, req.user.id]);
    if (!existingRows.length) return res.status(404).json({ message: "Todo not found." });

    await dbp.query(
      `UPDATE employee_todos
       SET title = COALESCE(?, title),
           description = COALESCE(?, description),
           due_date = COALESCE(?, due_date),
           status = COALESCE(?, status)
       WHERE id = ?`,
      [title || null, description || null, due_date || null, status || null, todoId]
    );
    const [rows] = await dbp.query("SELECT * FROM employee_todos WHERE id = ?", [todoId]);
    res.json({ todo: rows[0] });
  } catch (err) {
    console.error("Update todo failed:", err);
    res.status(500).json({ message: "Could not update todo." });
  }
});

app.delete("/api/todos/:id", authMiddleware, requireRole("employee"), async (req, res) => {
  try {
    const [result] = await dbp.query("DELETE FROM employee_todos WHERE id = ? AND employee_id = ?", [req.params.id, req.user.id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: "Todo not found." });
    res.json({ success: true });
  } catch (err) {
    console.error("Delete todo failed:", err);
    res.status(500).json({ message: "Could not delete todo." });
  }
});

// ═══════════════════════════════════════════
//  WORK STATUS APIS
// ═══════════════════════════════════════════
app.get("/api/work-status", authMiddleware, async (req, res) => {
  try {
    let sql;
    let params = [];
    if (req.user.role === "manager") {
      sql = `
        SELECT ews.*, e.name AS employee_name, e.email 
        FROM employee_work_status ews
        JOIN employees e ON ews.employee_id = e.id
        WHERE e.company_id = ?
      `;
      params.push(req.user.company_id || 0);
    } else {
      sql = "SELECT * FROM employee_work_status WHERE employee_id = ?";
      params.push(req.user.id);
    }
    const [statuses] = await dbp.query(sql, params);
    res.json({ statuses });
  } catch (err) {
    console.error("Load work status failed:", err);
    res.status(500).json({ message: "Could not load work statuses." });
  }
});

app.put("/api/work-status", authMiddleware, requireRole("employee"), async (req, res) => {
  const { status } = req.body;
  const allowedStatuses = new Set(['Online', 'Working', 'Busy', 'On Break', 'Offline']);
  if (!status || !allowedStatuses.has(status)) {
    return res.status(400).json({ message: "Invalid status." });
  }

  try {
    await dbp.query(
      `INSERT INTO employee_work_status (employee_id, current_status) 
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE current_status = ?`,
      [req.user.id, status, status]
    );
    
    emitToCompany("manager", req.user.company_id, "employee:status_changed", {
      employee_id: req.user.id,
      employee_name: req.user.name,
      status: status
    });
    
    res.json({ success: true, status });
  } catch (err) {
    console.error("Update work status failed:", err);
    res.status(500).json({ message: "Could not update work status." });
  }
});

app.post("/api/workspace/create", async (req, res) => {
  const { workspace_name, company_name, user_name, role, token } = req.body;
  if (!workspace_name || !company_name || !user_name || !role) {
    return res.status(400).json({ message: "Workspace name, company name, user name, and role are required." });
  }
  let createdBy = null;
  if (token) {
    try {
      const decoded = jwt.verify(token, SECRET);
      createdBy = decoded.id || null;
    } catch {
      createdBy = null;
    }
  }
  try {
    const [result] = await dbp.query(
      "INSERT INTO workspaces (workspace_name, company_name, created_by) VALUES (?, ?, ?)",
      [workspace_name.trim(), company_name.trim(), createdBy]
    );
    const workspace = {
      id: result.insertId,
      workspace_name: workspace_name.trim(),
      company_name: company_name.trim(),
      created_by: createdBy,
      created_at: new Date().toISOString(),
    };
    if (createdBy) {
      await dbp.query(
        "INSERT IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)",
        [workspace.id, createdBy, role]
      );
    }
    io.emit("workspace_created", workspace);
    res.status(201).json({ workspace });
  } catch (err) {
    console.error("Create workspace failed:", err);
    res.status(500).json({ message: "Could not create workspace." });
  }
});

app.get("/api/workspace/:id", async (req, res) => {
  try {
    const [rows] = await dbp.query("SELECT * FROM workspaces WHERE id = ?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: "Workspace not found." });
    const workspace = rows[0];
    const [members] = await dbp.query(
      "SELECT workspace_members.*, employees.name AS employee_name, managers.name AS manager_name FROM workspace_members " +
      "LEFT JOIN employees ON workspace_members.user_id = employees.id " +
      "LEFT JOIN managers ON workspace_members.user_id = managers.id " +
      "WHERE workspace_members.workspace_id = ?",
      [workspace.id]
    );
    res.json({ workspace, members });
  } catch (err) {
    console.error("Load workspace failed:", err);
    res.status(500).json({ message: "Could not load workspace." });
  }
});

app.put("/api/workspace/update/:id", async (req, res) => {
  const { workspace_name, company_name } = req.body;
  if (!workspace_name && !company_name) {
    return res.status(400).json({ message: "Workspace name or company name is required." });
  }
  try {
    const updates = [];
    const params = [];
    if (workspace_name) {
      updates.push("workspace_name = ?");
      params.push(workspace_name.trim());
    }
    if (company_name) {
      updates.push("company_name = ?");
      params.push(company_name.trim());
    }
    params.push(req.params.id);
    await dbp.query(`UPDATE workspaces SET ${updates.join(", ")} WHERE id = ?`, params);
    const [rows] = await dbp.query("SELECT * FROM workspaces WHERE id = ?", [req.params.id]);
    const workspace = rows[0];
    io.emit("workspace_updated", workspace);
    res.json({ workspace });
  } catch (err) {
    console.error("Update workspace failed:", err);
    res.status(500).json({ message: "Could not update workspace." });
  }
});
// ═══════════════════════════════════════════
//  COMPANY REGISTER API
// ═══════════════════════════════════════════
app.post("/api/register-company", (req, res) => {

  const {
    company_name,
    company_email,
    company_phone,
    company_address,
    manager_id,
    manager_name,
    manager_email,
    manager_password
  } = req.body;

  // Validation
  if (
    !company_name ||
    !company_email ||
    !company_phone ||
    !company_address ||
    !manager_id ||
    !manager_name ||
    !manager_email ||
    !manager_password
  ) {
    return res.status(400).json({
      message: "All fields are required."
    });
  }

  // 1. Insert Company
  const companySQL = `
    INSERT INTO companies
    (
      company_name,
      company_email,
      company_phone,
      company_address
    )
    VALUES (?, ?, ?, ?)
  `;

  db.query(
    companySQL,
    [
      company_name,
      company_email,
      company_phone,
      company_address
    ],
    async (companyErr, companyResult) => {

      if (companyErr) {

        console.log(companyErr);

        return res.status(500).json({
          message: "Company registration failed."
        });

      }

      const companyId = companyResult.insertId;
      const hashedManagerPassword = await bcryptjs.hash(String(manager_password), 10);

      // 2. Insert Manager
      const managerSQL = `
        INSERT INTO managers
        (
          id,
          company_id,
          name,
          email,
          password
        )
        VALUES (?, ?, ?, ?, ?)
      `;

      db.query(
        managerSQL,
        [
          manager_id,
          companyId,
          manager_name,
          manager_email,
          hashedManagerPassword
        ],
        (managerErr) => {

          if (managerErr) {

            console.log(managerErr);

            return res.status(500).json({
              message: "Manager account creation failed."
            });

          }

          return res.json({
            success: true,
            message: "Company Registered Successfully"
          });

        }
      );

    }
  );

});

// ═══════════════════════════════════════════
//  SOCKET.IO
// ═══════════════════════════════════════════
const io = new Server(server, {
  cors        : { origin: "*", methods: ["GET", "POST"] },
  pingTimeout : 30000,
  pingInterval: 10000,
});
app.set('io', io);

const users = new Map();
const rooms = new Map();
const calls = new Map();

["general", "random"].forEach((name) => {
  rooms.set(name, {
    id     : name,
    name   : `# ${name}`,
    type   : "group",
    members: new Set(),
  });
});

const getOnlineUsers = () =>
  [...users.values()].map(({ id, username, avatar, role }) => ({ id, username, avatar, role }));

const getRoomList = () =>
  [...rooms.values()]
    .filter((r) => r.type === "group")
    .map(({ id, name, members }) => ({ id, name, memberCount: members.size }));

function joinRoom(socket, roomId) {
  const room = rooms.get(roomId);
  const user = users.get(socket.id);
  if (!room || !user) return;
  socket.join(roomId);
  room.members.add(socket.id);
  user.rooms.add(roomId);
  socket.emit("room:joined", { roomId, name: room.name });
  if (room.type === "group") {
    io.to(roomId).emit("message:receive", {
      id       : `sys-${Date.now()}`,
      roomId,
      text     : `${user.username} joined the room`,
      sender   : { id: "system", username: "System", avatar: "" },
      timestamp: new Date().toISOString(),
      isSystem : true,
    });
  }
}

function getCallPeerId(call, socketId) {
  if (!call) return null;
  if (call.callerId === socketId) return call.calleeId;
  if (call.calleeId === socketId) return call.callerId;
  return null;
}

function endCall(callId, reason = "ended") {
  const call = calls.get(callId);
  if (!call) return;
  io.to(call.callerId).emit("call:ended", { callId, reason });
  io.to(call.calleeId).emit("call:ended", { callId, reason });
  io.to(call.callerId).emit("call-ended", { callId, reason });
  io.to(call.calleeId).emit("call-ended", { callId, reason });
  calls.delete(callId);
}

function relayCallSignal(socket, callId, eventName, payload) {
  const call = calls.get(callId);
  const targetId = getCallPeerId(call, socket.id);
  if (!targetId) return;
  io.to(targetId).emit(eventName, { callId, ...payload });
}

io.on("connection", (socket) => {
  console.log(`[+] connected    ${socket.id}`);

  socket.on("user:register", ({ username, token, role }) => {
    if (!username?.trim()) return;
    let userRole = role === "manager" ? "manager" : "employee";
    let realName = username.trim();
    let decoded = null;
    if (token) {
      try {
        decoded = jwt.verify(token, SECRET);
        userRole = decoded.role || userRole;
        realName = decoded.name || realName;
      } catch { decoded = null; }
    }
    const user = {
      id         : socket.id,
      userId     : decoded?.id || null,
      company_id : decoded?.company_id || null,
      username   : realName,
      avatar     : `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(realName)}`,
      role       : userRole,
      decoded,
      rooms      : new Set(),
    };
    users.set(socket.id, user);
    joinRoom(socket, "general");
    if (user.userId) {
      const personalRoom = getPersonalRoom(user.userId);
      socket.join(personalRoom);
    }
    if (user.company_id) {
      const workspaceRoom = getWorkspaceRoom(user.company_id);
      socket.join(workspaceRoom);
    }
    socket.emit("user:registered", {
      user       : { id: user.id, username: user.username, avatar: user.avatar, role: user.role, userId: user.userId, company_id: user.company_id },
      rooms      : getRoomList(),
      onlineUsers: getOnlineUsers(),
    });
    io.emit("presence:update", getOnlineUsers());
    io.emit("rooms:update",    getRoomList());
  });

  socket.on("room:join", ({ roomId }) => {
    if (!rooms.has(roomId)) return;
    joinRoom(socket, roomId);
    io.emit("rooms:update", getRoomList());
  });

  socket.on("join-room", ({ roomId }) => {
    if (!rooms.has(roomId)) return;
    joinRoom(socket, roomId);
    io.emit("rooms:update", getRoomList());
  });

  socket.on("room:create", ({ name }) => {
    if (!name?.trim()) return;
    const id = name.trim().toLowerCase().replace(/\s+/g, "-");
    if (rooms.has(id)) return socket.emit("error:room", { message: "Room already exists." });
    rooms.set(id, { id, name: `# ${name.trim()}`, type: "group", members: new Set() });
    joinRoom(socket, id);
    io.emit("rooms:update", getRoomList());
  });

  socket.on("message:send", async ({ roomId, text }) => {
    const user = users.get(socket.id);
    if (!user || !roomId || !rooms.has(roomId) || !text?.trim()) return;
    const message = {
      id       : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      roomId,
      text     : text.trim(),
      sender   : { id: user.id, userId: user.userId, username: user.username, avatar: user.avatar, role: user.role },
      timestamp: new Date().toISOString(),
    };
    try {
      await dbp.query(
        "INSERT INTO messages (room_id, sender_id, sender_user_id, sender_name, sender_role, message) VALUES (?, ?, ?, ?, ?, ?)",
        [roomId, user.id, user.userId, user.username, user.role, text.trim()]
      );
      await logActivity(user.userId, user.role, "message_sent", `Message sent in ${roomId}`);
    } catch (err) {
      console.error("Save message failed:", err.message);
    }
    io.to(roomId).emit("message:receive", message);
  });

  socket.on("dm:open", ({ targetId }) => {
    const me   = users.get(socket.id);
    const them = users.get(targetId);
    if (!me || !them || targetId === socket.id) return;
    const roomId = [socket.id, targetId].sort().join("__dm__");
    if (!rooms.has(roomId)) {
      rooms.set(roomId, { id: roomId, name: "DM", type: "dm", members: new Set([socket.id, targetId]) });
    }
    socket.join(roomId);
    io.sockets.sockets.get(targetId)?.join(roomId);
    socket.emit("dm:opened", { roomId, with: { id: them.id, username: them.username, avatar: them.avatar } });
    io.to(targetId).emit("dm:incoming", { roomId, from: { id: me.id, username: me.username, avatar: me.avatar } });
  });

  socket.on("typing:start", ({ roomId }) => {
    const user = users.get(socket.id);
    if (user) socket.to(roomId).emit("typing:update", { userId: user.id, username: user.username, isTyping: true });
  });

  socket.on("typing:stop", ({ roomId }) => {
    const user = users.get(socket.id);
    if (user) socket.to(roomId).emit("typing:update", { userId: user.id, username: user.username, isTyping: false });
  });

  // ── WebRTC Signaling ──────────────────────
  socket.on("call:initiate", ({ targetId, callType }) => {
    const caller = users.get(socket.id);
    const target = users.get(targetId);
    if (!caller || !target) return socket.emit("call:error", { message: "User not available." });
    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    calls.set(callId, { id: callId, callerId: socket.id, calleeId: targetId, type: callType, status: "ringing" });
    io.to(targetId).emit("call:incoming", {
      callId,
      from    : { id: caller.id, username: caller.username, avatar: caller.avatar },
      callType,
    });
    socket.emit("call:ringing", { callId, to: target.username });
  });

  socket.on("call:accept", ({ callId }) => {
    const call = calls.get(callId);
    if (!call || call.calleeId !== socket.id) return;
    call.status = "active";
    io.to(call.callerId).emit("call:accepted", { callId, by: users.get(socket.id) });
  });

  socket.on("call:end", ({ callId }) => {
    endCall(callId, "ended");
  });

  socket.on("call-ended", ({ callId }) => {
    endCall(callId, "ended");
  });

  socket.on("webrtc:offer", ({ callId, sdp }) => {
    relayCallSignal(socket, callId, "webrtc:offer", { sdp });
    relayCallSignal(socket, callId, "offer", { sdp });
  });

  socket.on("offer", ({ callId, sdp }) => {
    relayCallSignal(socket, callId, "offer", { sdp });
    relayCallSignal(socket, callId, "webrtc:offer", { sdp });
  });

  socket.on("webrtc:answer", ({ callId, sdp }) => {
    relayCallSignal(socket, callId, "webrtc:answer", { sdp });
    relayCallSignal(socket, callId, "answer", { sdp });
  });

  socket.on("answer", ({ callId, sdp }) => {
    relayCallSignal(socket, callId, "answer", { sdp });
    relayCallSignal(socket, callId, "webrtc:answer", { sdp });
  });

  socket.on("webrtc:ice", ({ callId, candidate }) => {
    relayCallSignal(socket, callId, "webrtc:ice", { candidate });
    relayCallSignal(socket, callId, "ice-candidate", { candidate });
  });

  socket.on("ice-candidate", ({ callId, candidate }) => {
    relayCallSignal(socket, callId, "ice-candidate", { candidate });
    relayCallSignal(socket, callId, "webrtc:ice", { candidate });
  });

  socket.on("disconnect", (reason) => {
    const user = users.get(socket.id);
    if (!user) return;
    console.log(`[-] disconnected ${socket.id} (${reason})`);
    for (const [callId, call] of calls.entries()) {
      if (call.callerId === socket.id || call.calleeId === socket.id) {
        const otherId = call.callerId === socket.id ? call.calleeId : call.callerId;
        io.to(otherId).emit("call:ended", { callId, reason: "peer_disconnected" });
        calls.delete(callId);
      }
    }
    user.rooms.forEach((roomId) => rooms.get(roomId)?.members.delete(socket.id));
    users.delete(socket.id);
    io.emit("presence:update", getOnlineUsers());
    io.emit("rooms:update",    getRoomList());
  });
});

// ═══════════════════════════════════════════
//  START
// ═══════════════════════════════════════════
// On Vercel the app is imported as a serverless function, so don't listen there.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Hello!  FlowDesk Server → http://localhost:${PORT}`);
    console.log(`    Login API → POST /api/login`);
    console.log(`    Me API    → GET  /api/me  (requires Bearer token)`);
  });
}

module.exports = app;
