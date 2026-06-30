const socket = io("http://localhost:5000");

const token = localStorage.getItem("token");
const username = localStorage.getItem("name");

let currentRoom = null;
let selectedUserId = null;

// CONNECT USER
socket.emit("user:register", {
    username,
    token
});

// RECEIVE ONLINE USERS
socket.on("presence:update", (users) => {

    console.log(users);

    const usersContainer =
    document.getElementById("chat-messages");

    // FILTER ONLY MANAGERS
    const managers =
    users.filter(user => user.role === "manager");

    managers.forEach(user => {

        usersContainer.innerHTML += `
            <div style="
                padding:10px;
                border-bottom:1px solid #ddd;
                cursor:pointer;
            "
            onclick="openDM('${user.id}')">

                🟢 ${user.username}

            </div>
        `;
    });

});

// OPEN PRIVATE CHAT
function openDM(targetId) {

    selectedUserId = targetId;

    socket.emit("dm:open", {
        targetId
    });

}

// RECEIVE ROOM
socket.on("dm:opened", (data) => {

    currentRoom = data.roomId;

    console.log("Connected Room:", currentRoom);

});

// SEND MESSAGE
function sendChatMessage() {

    const input =
    document.getElementById("chat-input");

    if (!input.value.trim()) return;

    socket.emit("message:send", {
        roomId: currentRoom,
        text: input.value
    });

    input.value = "";

}

// RECEIVE MESSAGE
socket.on("message:receive", (msg) => {

    const chat =
    document.getElementById("chat-messages");

    chat.innerHTML += `
        <div style="
            margin-bottom:10px;
            padding:10px;
            background:#eff6ff;
            border:1px solid #bfdbfe;
        ">
            <b>${msg.sender.username}</b><br>
            ${msg.text}
        </div>
    `;

});
 // --- State Variables ---
    let tasks = [];
    let employeeRequests = [];
    let employeeNotifications = [];
    let isPunchedIn = false;
    let isOnline = true;
    let calActiveDay = null;
    let calActiveMonth = null;
    let calActiveYear = null;
    let currentMonthOffset = 0;
    let reminderInterval = null;
    let realtimeSocket = null;
    let realtimeUser = null;
    let onlineUsers = [];
    let activeRoomId = "general";
    let selectedCallRoom = "General";
    let currentCallType = "video";
    let currentCallId = null;
    let currentPeerId = null;
    let pendingIncomingCall = null;
    let pendingIceCandidates = [];
    let peerConnection = null;
    let localStream = null;
    const configuration = {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        {
          urls: "turn:global.relay.metered.ca:80",
          username: "openrelayproject",
          credential: "openrelayproject"
        }
      ]
    };

    // --- Initialization ---
    window.onload = function () {
      // Check Theme
      if (localStorage.getItem('theme') === 'dark') {
        document.documentElement.classList.add('dark');
        document.getElementById('theme-icon').classList.replace('fa-moon', 'fa-sun');
      }

      // Loader Animation
      const progressBar = document.getElementById('loader-progress');
      const loaderText = document.getElementById('loader-text');
      const loader = document.getElementById('loader');

      setTimeout(() => { progressBar.style.width = '40%'; loaderText.innerText = 'Loading workspace...'; }, 100);
      setTimeout(() => { progressBar.style.width = '80%'; loaderText.innerText = 'Syncing data...'; }, 600);
      setTimeout(() => { progressBar.style.width = '100%'; loaderText.innerText = 'Ready.'; }, 1000);

      setTimeout(() => {
        loader.style.opacity = '0';
        setTimeout(() => {
          loader.style.display = 'none';
        }, 500); // Wait for fade transition
      }, 1400); // Display loader for 1.4 seconds

      startClock();
      renderCalendar();
      loadWorkspaceData();

      const dateOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
      document.getElementById('current-date').textContent = new Date().toLocaleDateString('en-US', dateOptions);
      document.getElementById('personal-notes').value = localStorage.getItem('flowdesk_notes') || '';
      updateDashboardNotesPreview();

      // Start reminder checker
      reminderInterval = setInterval(checkReminders, 10000); // Check every 10 seconds
      initRealtime();
    };

    function authHeaders() {
      return {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${localStorage.getItem("token") || localStorage.getItem("flowdesk_token") || ""}`
      };
    }

    async function apiFetch(url, options = {}) {
      const response = await fetch(url, {
        ...options,
        headers: { ...authHeaders(), ...(options.headers || {}) }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || "Request failed.");
      return data;
    }

    async function loadWorkspaceData() {
      try {
        const [taskData, requestData, notificationData] = await Promise.all([
          apiFetch("/api/tasks"),
          apiFetch("/api/requests"),
          apiFetch("/api/notifications")
        ]);
        tasks = taskData.tasks || [];
        employeeRequests = requestData.requests || [];
        employeeNotifications = notificationData.notifications || [];
        renderTasks();
        renderEmployeeRequests();
        renderEmployeeNotifications();
      } catch (error) {
        renderTasks();
        showToast(error.message || "Could not load workspace data.");
      }
    }

    // --- Theme Toggle Logic ---
    function toggleTheme() {
      document.documentElement.classList.toggle('dark');
      const icon = document.getElementById('theme-icon');
      if (document.documentElement.classList.contains('dark')) {
        icon.classList.remove('fa-moon');
        icon.classList.add('fa-sun');
        localStorage.setItem('theme', 'dark');
      } else {
        icon.classList.remove('fa-sun');
        icon.classList.add('fa-moon');
        localStorage.setItem('theme', 'light');
      }
    }

    // --- Clock Logic ---
    function startClock() {
      setInterval(() => {
        const now = new Date();
        document.getElementById('live-clock').textContent = now.toLocaleTimeString('en-US', { hour12: true });
      }, 1000);
    }

    // --- Navigation Logic ---
    function toggleSidebar() {
      const sidebar = document.getElementById('sidebar');
      const overlay = document.getElementById('mobile-overlay');
      sidebar.classList.toggle('-translate-x-full');
      overlay.classList.toggle('hidden');
    }

    function switchSection(sectionId, btnElement) {
      document.querySelectorAll('.section-content').forEach(sec => sec.classList.add('hidden'));
      document.getElementById('section-' + sectionId).classList.remove('hidden');

      const navBtns = document.querySelectorAll('.nav-btn');
      navBtns.forEach(btn => {
        btn.className = 'nav-btn flex items-center gap-3 w-full text-left px-4 py-2.5 text-slate-600 hover:bg-slate-50 hover:text-blue-600 border-l-4 border-transparent hover:border-blue-300 font-medium transition-colors';
      });

      if (btnElement) {
        btnElement.className = 'nav-btn flex items-center gap-3 w-full text-left px-4 py-2.5 bg-blue-50 text-blue-700 border-l-4 border-blue-600 font-semibold transition-colors';
      }
      if (window.innerWidth < 768) toggleSidebar();
    }

    function goToSection(sectionId) {
      // Find corresponding nav button
      const buttons = document.querySelectorAll('.nav-btn');
      for (let btn of buttons) {
        if (btn.innerText.toLowerCase().includes(sectionId.toLowerCase())) {
          switchSection(sectionId, btn);
          break;
        }
      }
    }

    // --- Task Management & Dashboard Stats ---
    function renderTasks() {
      const list = document.getElementById('task-list');
      list.innerHTML = '';

      let pending = 0;
      let completed = 0;

      if (!tasks.length) {
        list.innerHTML = '<div class="p-6 text-slate-400 italic">No tasks assigned yet.</div>';
      }

      tasks.forEach(task => {
        const done = task.done || task.status === "completed";
        if (done) completed++; else pending++;

        const iconClass = done ? 'fas fa-check-square text-blue-600' : 'far fa-square text-slate-300';
        const textClass = done ? 'text-slate-400 line-through' : 'text-slate-900';
        const statusLabel = (task.status || "pending").replace("_", " ");
        const statusHtml = done
          ? '<span class="inline-block px-2 py-1 bg-blue-50 text-blue-700 text-xs font-bold border border-blue-200">Completed</span>'
          : `<span class="inline-block px-2 py-1 bg-slate-100 text-slate-600 text-xs font-bold border border-slate-200">${escapeHtml(statusLabel)}</span>`;
        const dueText = task.due || (task.due_date ? new Date(task.due_date).toLocaleString() : "No Due Date");
        const descText = task.desc || task.description || `Priority: ${task.priority || "normal"}`;

        list.innerHTML += `
                    <div class="grid grid-cols-1 md:grid-cols-12 gap-4 px-4 py-3 items-center hover:bg-slate-50 transition-colors border-b border-slate-200 last:border-0">
                        <div class="col-span-1 md:col-span-6 flex items-start gap-3">
                            <button class="mt-0.5 hover:text-blue-600 transition-colors" onclick="toggleTask(${task.id})">
                                <i class="${iconClass} text-lg"></i>
                            </button>
                            <div>
                                <div class="font-bold task-title ${textClass}">${escapeHtml(task.text || task.title)}</div>
                                <div class="text-xs text-slate-500 mt-1">${escapeHtml(descText)}</div>
                            </div>
                        </div>
                        <div class="col-span-1 md:col-span-2 text-slate-600 text-sm">
                            <i class="far fa-calendar-alt mr-1"></i> ${escapeHtml(dueText)}
                        </div>
                        <div class="col-span-1 md:col-span-2">
                            ${statusHtml}
                        </div>
                        <div class="col-span-1 md:col-span-2 text-left md:text-right">
                            <button class="text-slate-400 hover:text-blue-600 text-sm font-medium transition-colors" onclick="setTaskStatus(${task.id}, 'in_progress')" title="Start"><i class="fas fa-play"></i></button>
                            <button class="text-slate-400 hover:text-blue-600 text-sm font-medium transition-colors ml-3" onclick="setTaskStatus(${task.id}, 'review')" title="Send to review"><i class="fas fa-eye"></i></button>
                        </div>
                    </div>
                `;
      });

      // Update Dashboard Stats
      document.getElementById('dash-pending-tasks').innerText = pending;
      document.getElementById('dash-completed-tasks').innerText = completed;
    }

    function addNewTask() {
      showToast("Only managers can assign official tasks.");
    }

    async function setTaskStatus(id, status) {
      try {
        const data = await apiFetch(`/api/tasks/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ status })
        });
        tasks = tasks.map(task => task.id === id ? data.task : task);
        renderTasks();
        showToast("Task status updated.");
      } catch (error) {
        showToast(error.message || "Could not update task.");
      }
    }

    async function completeTask(id) {
      return setTaskStatus(id, "completed");
    }

    function toggleTask(id) {
      const task = tasks.find(t => t.id === id);
      if (task) setTaskStatus(id, task.status === "completed" ? "pending" : "completed");
    }

    function deleteTask(id) {
      showToast("Ask your manager to delete assigned tasks.");
    }

    function renderEmployeeRequests() {
      const list = document.getElementById("employee-request-list");
      if (!list) return;
      if (!employeeRequests.length) {
        list.innerHTML = '<div class="p-4 text-slate-400 italic">No requests sent yet.</div>';
        return;
      }
      list.innerHTML = employeeRequests.map(request => `
        <div class="p-4">
          <div class="flex items-center justify-between gap-3">
            <div class="font-bold text-slate-900">${escapeHtml(getEmployeeRequestTitle(request))}</div>
            <span class="text-xs font-bold px-2 py-1 border ${request.status === 'approved' ? 'bg-green-50 text-green-700 border-green-200' : request.status === 'rejected' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-slate-100 text-slate-600 border-slate-200'}">${escapeHtml(request.status)}</span>
          </div>
          <div class="text-sm text-slate-600 mt-2">${escapeHtml(getEmployeeRequestMessage(request))}</div>
          ${request.manager_note ? `<div class="text-xs text-slate-500 mt-2">Manager note: ${escapeHtml(request.manager_note)}</div>` : ""}
        </div>
      `).join("");
    }

    function getEmployeeRequestTitle(request) {
      return request?.request_type || request?.request_title || request?.title || "Request";
    }

    function getEmployeeRequestMessage(request) {
      return request?.details || request?.request_message || request?.description || "";
    }

    async function sendEmployeeRequest() {
      const requestType = document.getElementById("request-type").value;
      const details = document.getElementById("request-details").value.trim();
      if (!details) return showToast("Please write request details.");
      try {
        const data = await apiFetch("/api/requests", {
          method: "POST",
          body: JSON.stringify({ request_type: requestType, details })
        });
        employeeRequests.unshift(data.request);
        document.getElementById("request-details").value = "";
        renderEmployeeRequests();
        showToast("Request sent to manager.");
      } catch (error) {
        showToast(error.message || "Could not send request.");
      }
    }

    function renderEmployeeNotifications() {
      const list = document.getElementById("employee-notification-list");
      const badge = document.getElementById("employee-notification-count");
      const unread = employeeNotifications.filter(n => !n.is_read).length;
      if (badge) {
        badge.innerText = unread;
        badge.classList.toggle("hidden", unread === 0);
      }
      if (!list) return;
      if (!employeeNotifications.length) {
        list.innerHTML = '<div class="p-4 text-slate-400 italic">No notifications yet.</div>';
      } else {
        list.innerHTML = employeeNotifications.map(note => `
          <div class="p-4 ${note.is_read ? '' : 'bg-blue-50'}">
            <div class="font-bold text-slate-900">${escapeHtml(note.title)}</div>
            <div class="text-sm text-slate-600 mt-1">${escapeHtml(note.message)}</div>
            <div class="text-xs text-slate-400 mt-2">${new Date(note.created_at).toLocaleString()}</div>
          </div>
        `).join("");
      }
      renderEmployeeNotificationPanel();
    }

    function renderEmployeeNotificationPanel() {
      const panelList = document.getElementById("employee-notification-panel-list");
      const panelCount = document.getElementById("employee-notification-panel-count");
      const unread = employeeNotifications.filter(n => !n.is_read).length;
      if (panelCount) {
        panelCount.innerText = `${unread} unread`;
      }
      if (!panelList) return;
      if (!employeeNotifications.length) {
        panelList.innerHTML = '<div class="p-4 text-slate-400 italic">No notifications yet.</div>';
        return;
      }
      panelList.innerHTML = employeeNotifications.map(note => `
        <div class="p-4 border-b border-slate-200 last:border-0 ${note.is_read ? '' : 'bg-blue-50'}">
          <div class="font-bold text-slate-900">${escapeHtml(note.title)}</div>
          <div class="text-sm text-slate-600 mt-1">${escapeHtml(note.message)}</div>
          <div class="text-[11px] text-slate-400 mt-2">${new Date(note.created_at).toLocaleString()}</div>
        </div>
      `).join("");
    }

    async function markAllEmployeeNotificationsRead() {
      try {
        await apiFetch("/api/notifications/read", { method: "PATCH" });
        employeeNotifications = employeeNotifications.map(note => ({ ...note, is_read: 1 }));
        renderEmployeeNotifications();
        showToast("All notifications marked read.");
      } catch (error) {
        showToast(error.message || "Could not update notifications.");
      }
    }

    function toggleEmployeeNotificationPanel() {
      const panel = document.getElementById("employee-notification-panel");
      if (!panel) return;
      panel.classList.toggle("hidden");
      renderEmployeeNotificationPanel();
    }

    window.addEventListener("click", (event) => {
      const panel = document.getElementById("employee-notification-panel");
      const button = document.getElementById("employee-notification-button");
      if (!panel || !button) return;
      if (panel.classList.contains("hidden")) return;
      if (!event.target.closest("#employee-notification-panel") && !event.target.closest("#employee-notification-button")) {
        panel.classList.add("hidden");
      }
    });

    // --- Attendance Logic ---
    function punchAttendance() {
      const statusText = document.getElementById('attendance-status-text');
      const btn = document.getElementById('punch-btn');
      const log = document.getElementById('attendance-log');
      const dashMyAttendance = document.getElementById('dash-my-attendance');
      const dashPresent = document.getElementById('dash-present');

      const now = new Date();
      const timeStr = now.toLocaleTimeString('en-US', { hour12: true });

      if (!isPunchedIn) {
        // Punching In
        isPunchedIn = true;
        statusText.innerText = `You punched in today at ${timeStr}.`;
        btn.innerText = "PUNCH OUT";
        btn.className = "w-full bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold py-3 border border-slate-300 transition-colors";

        log.innerHTML = `<div class="border-l-2 border-blue-600 pl-3 py-1">Punched IN at <span class="font-bold text-slate-900">${timeStr}</span></div>` + (log.innerHTML.includes('No records') ? '' : log.innerHTML);

        dashMyAttendance.innerText = `Punched In (${timeStr})`;
        dashPresent.innerText = parseInt(dashPresent.innerText) + 1; // Increase present count
            showToast("Punched In Successfully.");
        updateWorkStatus("Online");
      } else {
        // Punching Out
        isPunchedIn = false;
        statusText.innerText = `You punched out today at ${timeStr}.`;
        btn.innerText = "PUNCH IN";
        btn.className = "w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 border border-blue-700 transition-colors";

        log.innerHTML = `<div class="border-l-2 border-slate-400 pl-3 py-1">Punched OUT at <span class="font-bold text-slate-900">${timeStr}</span></div>` + log.innerHTML;

        dashMyAttendance.innerText = `Punched Out`;
        dashPresent.innerText = parseInt(dashPresent.innerText) - 1; // Decrease present count
        showToast("Punched Out Successfully.");
        updateWorkStatus("Offline");
      }
    }

    async function updateWorkStatus(status) {
      try {
        await apiFetch("/api/work-status", {
          method: "PUT",
          body: JSON.stringify({ status })
        });
      } catch (error) {
        console.warn("Could not update manager status:", error.message || error);
      }
    }

    // --- Calendar Logic ---
    function changeMonth(offset) {
      currentMonthOffset += offset;
      renderCalendar();
    }

    function renderCalendar() {
      const grid = document.getElementById('calendar-grid');
      grid.innerHTML = '';

      const now = new Date();
      const targetDate = new Date(now.getFullYear(), now.getMonth() + currentMonthOffset, 1);

      const currentMonth = targetDate.getMonth();
      const currentYear = targetDate.getFullYear();

      const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      document.getElementById('cal-month-display').innerText = `${monthNames[currentMonth]} ${currentYear}`;

      const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
      const firstDayIndex = new Date(currentYear, currentMonth, 1).getDay();

      const realToday = new Date();
      const isCurrentMonth = realToday.getMonth() === currentMonth && realToday.getFullYear() === currentYear;

      // Empty slots before first day
      for (let i = 0; i < firstDayIndex; i++) {
        grid.innerHTML += `<div class="calendar-day border-b border-r border-slate-200 p-2 h-20 bg-slate-50"></div>`;
      }

      let savedNotes = JSON.parse(localStorage.getItem('flowdesk_cal_notes')) || {};

      for (let i = 1; i <= daysInMonth; i++) {
        const isToday = isCurrentMonth && i === realToday.getDate();
        const todayBg = isToday ? 'bg-blue-50 border-blue-300' : '';
        const todayBadge = isToday ? 'bg-blue-600 text-white rounded-full w-6 h-6 flex items-center justify-center ml-auto' : 'text-slate-700 text-right';

        const dateKey = `${i}-${currentMonth}-${currentYear}`;
        const noteObj = savedNotes[dateKey];
        const noteText = noteObj ? noteObj.text : '';

        grid.innerHTML += `
                    <div class="calendar-day border-b border-r border-slate-200 p-1.5 sm:p-2 h-20 transition-colors relative ${todayBg}" onclick="openCalendarNote(${i}, ${currentMonth}, ${currentYear})">
                        <div class="font-bold ${todayBadge}">${i}</div>
                        <div id="cal-note-disp-${i}" class="text-[10px] text-blue-700 mt-1 leading-tight overflow-hidden text-ellipsis whitespace-nowrap">${noteText}</div>
                    </div>
                `;
      }
    }

    function openCalendarNote(day, month, year) {
      calActiveDay = day;
      calActiveMonth = month;
      calActiveYear = year;

      const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      document.getElementById('cal-note-title').innerText = `Notes for ${monthNames[month]} ${day}, ${year}`;

      const dateKey = `${day}-${month}-${year}`;
      let savedNotes = JSON.parse(localStorage.getItem('flowdesk_cal_notes')) || {};

      if (savedNotes[dateKey]) {
        document.getElementById('cal-note-input').value = savedNotes[dateKey].text;
        document.getElementById('cal-note-time').value = savedNotes[dateKey].time || "";
        document.getElementById('cal-note-delete-btn').classList.remove('hidden');
      } else {
        document.getElementById('cal-note-input').value = "";
        document.getElementById('cal-note-time').value = "";
        document.getElementById('cal-note-delete-btn').classList.add('hidden');
      }

      document.getElementById('calendar-note-modal').classList.remove('hidden');
    }

    function saveCalendarNote() {
      const text = document.getElementById('cal-note-input').value.trim();
      const time = document.getElementById('cal-note-time').value;
      const dateKey = `${calActiveDay}-${calActiveMonth}-${calActiveYear}`;

      let savedNotes = JSON.parse(localStorage.getItem('flowdesk_cal_notes')) || {};

      if (!text) {
        delete savedNotes[dateKey];
        showToast("Calendar note removed.");
      } else {
        savedNotes[dateKey] = { text: text, time: time, notified: false };
        if (time) {
          showToast(`Reminder scheduled for ${time}.`);
        } else {
          showToast("Calendar note saved.");
        }
      }

      localStorage.setItem('flowdesk_cal_notes', JSON.stringify(savedNotes));

      closeModals();
      renderCalendar();
    }

    function deleteCalendarNote() {
      const dateKey = `${calActiveDay}-${calActiveMonth}-${calActiveYear}`;
      let savedNotes = JSON.parse(localStorage.getItem('flowdesk_cal_notes')) || {};
      delete savedNotes[dateKey];
      localStorage.setItem('flowdesk_cal_notes', JSON.stringify(savedNotes));
      closeModals();
      renderCalendar();
      showToast("Calendar note deleted.");
    }

    function playAlertSound() {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime); // High pitch beep
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + 0.5);
        osc.start();
        osc.stop(ctx.currentTime + 0.5);
      } catch (e) {
        console.log("Audio alert not supported or blocked.");
      }
    }

    function checkReminders() {
      const now = new Date();
      const currentDay = now.getDate();
      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();

      // Format HH:MM
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const currentTime = `${hours}:${minutes}`;

      const todayKey = `${currentDay}-${currentMonth}-${currentYear}`;
      let savedNotes = JSON.parse(localStorage.getItem('flowdesk_cal_notes')) || {};

      if (savedNotes[todayKey] && savedNotes[todayKey].time === currentTime && !savedNotes[todayKey].notified) {
        // Show Prominent Alert Modal
        document.getElementById('reminder-alert-text').innerText = savedNotes[todayKey].text;
        document.getElementById('reminder-alert-modal').classList.remove('hidden');
        playAlertSound();

        savedNotes[todayKey].notified = true; // Mark as notified to prevent repeating
        localStorage.setItem('flowdesk_cal_notes', JSON.stringify(savedNotes));
        renderCalendar();
      }
    }

    function closeReminderAlert() {
      document.getElementById('reminder-alert-modal').classList.add('hidden');
    }

    // --- Realtime Chat & Calls ---
    function initRealtime() {
      if (typeof io === "undefined") {
        showToast("Realtime server is unavailable.");
        return;
      }

      realtimeSocket = io();
      realtimeSocket.on("connect", () => {
        realtimeSocket.emit("user:register", {
          username: "Janam Jain",
          role: "employee",
          token: localStorage.getItem("token") || localStorage.getItem("flowdesk_token")
        });
      });
      realtimeSocket.on("disconnect", () => {
        if (currentCallId) endCurrentCall(false);
      });

      realtimeSocket.on("user:registered", ({ user, onlineUsers: users }) => {
        realtimeUser = user;
        onlineUsers = users || [];
        renderOnlineUsers();
      });
      realtimeSocket.on("presence:update", (users) => {
        onlineUsers = users || [];
        renderOnlineUsers();
      });
      realtimeSocket.on("message:receive", renderChatMessage);
      realtimeSocket.on("notification:new", (notification) => {
        employeeNotifications.unshift(notification);
        renderEmployeeNotifications();
        showToast(notification.message || notification.title || "New notification");
      });
      realtimeSocket.on("new_notification", (notification) => {
        employeeNotifications.unshift(notification);
        renderEmployeeNotifications();
        showToast(notification.message || notification.title || "New notification");
      });
      realtimeSocket.on("request:changed", (request) => {
        employeeRequests = employeeRequests.map(item => item.id === request.id ? request : item);
        renderEmployeeRequests();
      });
      realtimeSocket.on("request:decision_result", (request) => {
        const existingIndex = employeeRequests.findIndex(item => item.id === request.id);
        if (existingIndex >= 0) {
          employeeRequests[existingIndex] = request;
        } else {
          employeeRequests.unshift(request);
        }
        renderEmployeeRequests();
      });
      realtimeSocket.on("request_accepted", (request) => {
        const existingIndex = employeeRequests.findIndex(item => item.id === request.id);
        if (existingIndex >= 0) {
          employeeRequests[existingIndex] = request;
        } else {
          employeeRequests.unshift(request);
        }
        renderEmployeeRequests();
        showToast("Your request was accepted.");
      });
      realtimeSocket.on("request_rejected", (request) => {
        const existingIndex = employeeRequests.findIndex(item => item.id === request.id);
        if (existingIndex >= 0) {
          employeeRequests[existingIndex] = request;
        } else {
          employeeRequests.unshift(request);
        }
        renderEmployeeRequests();
        showToast("Your request was rejected.");
      });
      realtimeSocket.on("task:changed", (task) => {
        const exists = tasks.some(item => item.id === task.id);
        tasks = exists ? tasks.map(item => item.id === task.id ? task : item) : [task, ...tasks];
        renderTasks();
      });
      realtimeSocket.on("task:deleted", ({ id }) => {
        tasks = tasks.filter(task => task.id !== id);
        renderTasks();
      });
      realtimeSocket.on("call:incoming", handleIncomingCall);
      realtimeSocket.on("call:ringing", ({ to }) => showToast(`Calling ${to}...`));
      realtimeSocket.on("call:accepted", async ({ callId }) => {
        currentCallId = callId;
        await startPeerConnection(true);
      });
      realtimeSocket.on("webrtc:offer", handleOffer);
      realtimeSocket.on("webrtc:answer", handleAnswer);
      realtimeSocket.on("webrtc:ice", handleIce);
      realtimeSocket.on("offer", handleOffer);
      realtimeSocket.on("answer", handleAnswer);
      realtimeSocket.on("ice-candidate", handleIce);
      realtimeSocket.on("call:ended", () => endCurrentCall(false));
      realtimeSocket.on("call-ended", () => endCurrentCall(false));
      realtimeSocket.on("call:error", ({ message }) => showToast(message || "Call failed."));
    }

    function escapeHtml(value) {
      const div = document.createElement("div");
      div.textContent = value || "";
      return div.innerHTML;
    }

    function getInitials(name) {
      return String(name || "FD")
        .trim()
        .split(/\s+/)
        .map(part => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
    }

    function renderOnlineUsers() {
      const sidebar = document.querySelector("#chat-interface .w-64 .flex-1");
      const people = onlineUsers.filter(user => user.id !== realtimeUser?.id);
      if (sidebar) {
        const peopleHtml = people.map(user => `
          <button class="block w-full text-left px-4 py-2 text-slate-600 hover:bg-white hover:text-blue-600 border-l-2 border-transparent transition-colors"
            onclick="startDirectCall('${user.id}', 'video')">
            <span class="font-medium">${escapeHtml(user.username)}</span>
            <span class="text-[10px] uppercase text-slate-400 ml-1">${escapeHtml(user.role)}</span>
          </button>
        `).join("");
        sidebar.innerHTML = `
          <a href="#" class="block px-4 py-2 text-blue-700 bg-blue-50 border-l-2 border-blue-600 font-medium"># general-team</a>
          <div class="px-4 pt-4 pb-2 text-[10px] font-bold uppercase text-slate-400">Online for calls</div>
          ${peopleHtml || '<div class="px-4 py-2 text-xs text-slate-400">No one else online yet.</div>'}
        `;
      }
      renderCallDirectory();
    }

    function renderCallDirectory() {
      const list = document.getElementById("call-user-list");
      const count = document.getElementById("call-online-count");
      if (!list) return;
      const people = onlineUsers.filter(user => user.id !== realtimeUser?.id);
      if (count) count.innerText = `${people.length} online`;
      if (!people.length) {
        list.innerHTML = '<div class="p-4 text-sm text-slate-400">No manager or teammate is online yet. Open the manager page in another tab to test.</div>';
        return;
      }
      list.innerHTML = people.map(user => `
        <div class="p-4 flex items-center justify-between gap-3">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-10 h-10 border border-slate-200 bg-slate-100 text-slate-700 flex items-center justify-center font-bold shrink-0">${getInitials(user.username)}</div>
            <div class="min-w-0">
              <div class="font-bold text-slate-900 truncate">${escapeHtml(user.username)}</div>
              <div class="text-xs text-slate-500 uppercase">${escapeHtml(user.role)}</div>
            </div>
          </div>
          <div class="flex gap-1 shrink-0">
            <button onclick="startDirectCall('${user.id}', 'audio')" title="Audio call"
              class="w-9 h-9 bg-white border border-slate-300 text-slate-600 hover:text-blue-600 hover:border-blue-600">
              <i class="fas fa-phone"></i>
            </button>
            <button onclick="startDirectCall('${user.id}', 'video')" title="Video call"
              class="w-9 h-9 bg-blue-600 border border-blue-700 text-white hover:bg-blue-700">
              <i class="fas fa-video"></i>
            </button>
          </div>
        </div>
      `).join("");
    }

    function renderChatMessage(message) {
      if (message.roomId !== activeRoomId) return;
      const chatContainer = document.getElementById('chat-messages');
      if (!chatContainer) return;
      if (message.isSystem) {
        chatContainer.insertAdjacentHTML('beforeend', `<div class="text-center text-xs text-slate-400 my-4">${escapeHtml(message.text)}</div>`);
      } else {
        const isMine = message.isMine || message.sender?.id === realtimeUser?.id || (message.sender?.userId && String(message.sender.userId) === String(realtimeUser?.userId));
        const timeString = new Date(message.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const senderName = message.sender?.username || 'Team Member';
        chatContainer.insertAdjacentHTML('beforeend', `
          <div class="flex ${isMine ? 'justify-start' : 'justify-end'} fade-in">
            <div class="flex gap-3 max-w-[82%] ${isMine ? '' : 'flex-row-reverse text-right'}">
              <div class="w-10 h-10 border border-slate-200 bg-slate-100 text-slate-700 flex items-center justify-center font-bold shrink-0">${getInitials(senderName)}</div>
              <div>
                <div class="flex items-baseline gap-2 ${isMine ? '' : 'justify-end'}">
                  <span class="font-bold text-slate-900">${escapeHtml(senderName)}${isMine ? ' <span class="text-[10px] text-blue-600 ml-1">YOU</span>' : ''}</span>
                <span class="text-xs text-slate-400">${timeString}</span>
              </div>
                <div class="text-slate-700 mt-1 ${isMine ? 'bg-blue-50 border-blue-100' : 'bg-slate-50 border-slate-100'} border p-3 text-left break-words">${escapeHtml(message.text)}</div>
              </div>
            </div>
          </div>
        `);
      }
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function ensureCallPanel() {
      const consolePanel = document.getElementById("call-console-panel");
      if (consolePanel) return consolePanel;
      let panel = document.getElementById("live-call-panel");
      if (panel) return panel;
      panel = document.createElement("div");
      panel.id = "live-call-panel";
      panel.className = "fixed bottom-4 left-4 right-4 md:left-auto md:w-[520px] bg-white border border-slate-300 shadow-xl z-[120] hidden";
      panel.innerHTML = `
        <div class="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-slate-50">
          <div>
            <div class="font-bold text-slate-900" id="call-panel-title">FlowDesk Call</div>
            <div class="text-xs text-slate-500" id="call-panel-status">Connecting...</div>
          </div>
          <button onclick="endCurrentCall()" class="bg-red-600 text-white px-3 py-2 font-bold text-xs">End</button>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 p-3 bg-slate-900">
          <video id="remote-video" autoplay playsinline class="w-full bg-black min-h-[180px] object-cover"></video>
          <video id="local-video" autoplay playsinline muted class="w-full bg-black min-h-[180px] object-cover"></video>
        </div>
      `;
      document.body.appendChild(panel);
      return panel;
    }

    function showCallPanel(status) {
      const panel = ensureCallPanel();
      panel.classList.remove("hidden");
      goToSection("calls");
      document.getElementById("call-panel-title").innerText = selectedCallRoom;
      document.getElementById("call-panel-status").innerText = status;
      updateCallPlaceholders();
    }

    function updateCallPlaceholders() {
      const localPlaceholder = document.getElementById("local-video-placeholder");
      const remotePlaceholder = document.getElementById("remote-video-placeholder");
      const remoteVideo = document.getElementById("remote-video");
      const localHasVideo = !!localStream?.getVideoTracks().length;
      const remoteHasVideo = !!remoteVideo?.srcObject?.getVideoTracks?.().length;
      if (localPlaceholder) {
        localPlaceholder.innerText = localStream && !localHasVideo ? "Audio call active" : "Camera preview";
        localPlaceholder.classList.toggle("hidden", localHasVideo);
      }
      if (remotePlaceholder) {
        remotePlaceholder.innerText = remoteVideo?.srcObject && !remoteHasVideo ? "Remote audio connected" : "Waiting for peer...";
        remotePlaceholder.classList.toggle("hidden", remoteHasVideo);
      }
    }

    async function getCallStream(videoEnabled) {
      if (!navigator.mediaDevices?.getUserMedia) {
        const message = window.isSecureContext
          ? "This browser does not support camera or microphone access."
          : "Camera and microphone require HTTPS or localhost.";
        document.getElementById("call-panel-status").innerText = message;
        showToast(message);
        throw new Error(message);
      }
      if (localStream) {
        const hasVideo = localStream.getVideoTracks().length > 0;
        if (!videoEnabled || hasVideo) return localStream;
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
      }
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: videoEnabled });
        const localVideo = document.getElementById("local-video");
        if (localVideo) {
          localVideo.srcObject = localStream;
          await localVideo.play().catch(() => {});
        }
        updateCallPlaceholders();
        return localStream;
      } catch (error) {
        const message = error.name === "NotAllowedError" || error.name === "SecurityError"
          ? "Camera or microphone permission was blocked."
          : error.name === "NotFoundError"
            ? "Camera or microphone device was not found."
            : "Camera or microphone is not available.";
        document.getElementById("call-panel-status").innerText = message;
        showToast(message);
        throw error;
      }
    }

    async function startPeerConnection(isCaller) {
      showCallPanel("Connected");
      if (peerConnection) peerConnection.close();
      pendingIceCandidates = [];
      peerConnection = new RTCPeerConnection(configuration);
      peerConnection.onconnectionstatechange = () => {
        document.getElementById("call-panel-status").innerText = `Connection: ${peerConnection.connectionState}`;
        if (["failed", "closed"].includes(peerConnection.connectionState)) updateCallPlaceholders();
      };
      peerConnection.oniceconnectionstatechange = () => {
        if (peerConnection?.iceConnectionState === "failed") {
          peerConnection.restartIce?.();
          document.getElementById("call-panel-status").innerText = "Reconnecting media...";
        }
      };
      peerConnection.onicecandidate = event => {
        if (event.candidate) {
          realtimeSocket.emit("ice-candidate", { callId: currentCallId, candidate: event.candidate });
        }
      };
      peerConnection.ontrack = event => {
        const remoteVideo = document.getElementById("remote-video");
        if (remoteVideo && event.streams[0]) {
          remoteVideo.srcObject = event.streams[0];
          remoteVideo.play().catch(() => {});
        }
        updateCallPlaceholders();
      };
      const stream = await getCallStream(currentCallType === "video");
      stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));
      if (isCaller) {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        realtimeSocket.emit("offer", { callId: currentCallId, sdp: offer });
      }
    }

    function getPreferredCallTarget() {
      return onlineUsers.find(user => user.id !== realtimeUser?.id && user.role === "manager")
        || onlineUsers.find(user => user.id !== realtimeUser?.id);
    }

    function startDirectCall(targetId, callType = "video") {
      const target = onlineUsers.find(user => user.id === targetId);
      if (!target) return showToast("That user is not online.");
      if (currentCallId || peerConnection) endCurrentCall(false);
      selectedCallRoom = `Call with ${target.username}`;
      currentCallType = callType;
      currentPeerId = target.id;
      showCallPanel("Ringing...");
      realtimeSocket.emit("call:initiate", { targetId: target.id, callType });
    }

    function handleIncomingCall({ callId, from, callType }) {
      selectedCallRoom = `Call with ${from.username}`;
      currentCallType = callType;
      currentCallId = callId;
      currentPeerId = from.id;
      pendingIncomingCall = { callId, from, callType };
      showIncomingCallPrompt();
    }

    function showIncomingCallPrompt() {
      let prompt = document.getElementById("incoming-call-prompt");
      if (!prompt) {
        prompt = document.createElement("div");
        prompt.id = "incoming-call-prompt";
        prompt.className = "fixed top-4 right-4 bg-white border border-slate-300 shadow-xl z-[130] w-[320px]";
        document.body.appendChild(prompt);
      }
      prompt.innerHTML = `
        <div class="p-4 border-b border-slate-200 bg-slate-50">
          <div class="text-xs font-bold uppercase text-blue-600">${escapeHtml(pendingIncomingCall.callType)} call</div>
          <div class="font-bold text-slate-900 mt-1">${escapeHtml(pendingIncomingCall.from.username)}</div>
          <div class="text-xs text-slate-500 mt-1">Incoming FlowDesk call</div>
        </div>
        <div class="p-3 flex gap-2">
          <button onclick="declineIncomingCall()" class="flex-1 bg-white border border-slate-300 text-slate-700 font-bold py-2">Decline</button>
          <button onclick="acceptIncomingCall()" class="flex-1 bg-blue-600 border border-blue-700 text-white font-bold py-2">Accept</button>
        </div>
      `;
    }

    function acceptIncomingCall() {
      if (!pendingIncomingCall) return;
      showCallPanel("Connecting...");
      realtimeSocket.emit("call:accept", { callId: pendingIncomingCall.callId });
      document.getElementById("incoming-call-prompt")?.remove();
      pendingIncomingCall = null;
    }

    function declineIncomingCall() {
      if (!pendingIncomingCall) return;
      realtimeSocket.emit("call:end", { callId: pendingIncomingCall.callId });
      document.getElementById("incoming-call-prompt")?.remove();
      pendingIncomingCall = null;
    }

    async function handleOffer({ callId, sdp }) {
      if (currentCallId === callId && peerConnection?.remoteDescription) return;
      if (currentCallId && currentCallId !== callId) endCurrentCall(false);
      currentCallId = callId;
      await startPeerConnection(false);
      await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushPendingIceCandidates();
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      realtimeSocket.emit("answer", { callId, sdp: answer });
    }

    async function handleAnswer({ callId, sdp }) {
      if (!peerConnection || (callId && currentCallId && callId !== currentCallId)) return;
      if (peerConnection.signalingState === "stable") return;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushPendingIceCandidates();
    }

    async function handleIce({ callId, candidate }) {
      if (!candidate) return;
      if (callId && currentCallId && callId !== currentCallId) return;
      if (!peerConnection || !peerConnection.remoteDescription) {
        pendingIceCandidates.push(candidate);
        return;
      }
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.warn("Could not add ICE candidate", error);
      }
    }

    async function flushPendingIceCandidates() {
      if (!peerConnection || !peerConnection.remoteDescription) return;
      while (pendingIceCandidates.length) {
        const candidate = pendingIceCandidates.shift();
        try {
          await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
          console.warn("Could not add queued ICE candidate", error);
        }
      }
    }

    function endCurrentCall(notifyPeer = true) {
      if (notifyPeer && currentCallId && realtimeSocket?.connected) {
        realtimeSocket.emit("call:end", { callId: currentCallId });
        realtimeSocket.emit("call-ended", { callId: currentCallId });
      }
      if (peerConnection) peerConnection.close();
      if (localStream) localStream.getTracks().forEach(track => track.stop());
      peerConnection = null;
      localStream = null;
      pendingIceCandidates = [];
      currentCallId = null;
      currentPeerId = null;
      const panel = document.getElementById("live-call-panel");
      if (panel) panel.classList.add("hidden");
      document.getElementById("incoming-call-prompt")?.remove();
      pendingIncomingCall = null;
      const localVideo = document.getElementById("local-video");
      const remoteVideo = document.getElementById("remote-video");
      if (localVideo) localVideo.srcObject = null;
      if (remoteVideo) remoteVideo.srcObject = null;
      document.getElementById("call-panel-title").innerText = "No Active Call";
      document.getElementById("call-panel-status").innerText = "Choose someone online to start.";
      updateCallPlaceholders();
    }

    function toggleMute() {
      const audioTrack = localStream?.getAudioTracks()[0];
      if (!audioTrack) return showToast("No active microphone yet.");
      audioTrack.enabled = !audioTrack.enabled;
      const btn = document.getElementById("mute-call-btn");
      btn.innerHTML = audioTrack.enabled ? '<i class="fas fa-microphone mr-2"></i>Mute' : '<i class="fas fa-microphone-slash mr-2"></i>Unmute';
    }

    function toggleCamera() {
      const videoTrack = localStream?.getVideoTracks()[0];
      if (!videoTrack) return showToast("This is an audio call. Camera is not active.");
      videoTrack.enabled = !videoTrack.enabled;
      const btn = document.getElementById("camera-call-btn");
      btn.innerHTML = videoTrack.enabled ? '<i class="fas fa-video mr-2"></i>Camera' : '<i class="fas fa-video-slash mr-2"></i>Camera Off';
    }

    // --- Chat Authentication Logic ---
    function authenticateChat() {
      const id = document.getElementById('chat-emp-id').value;
      const email = document.getElementById('chat-emp-email').value;

      if (!id || !email) {
        showToast("Please enter Employee ID and Email");
        return;
      }

      document.getElementById('chat-auth-gate').classList.add('hidden');
      document.getElementById('chat-interface').classList.remove('hidden');
      renderOnlineUsers();
      showToast("Authentication successful.");
    }

    function sendChatMessage() {
      const input = document.getElementById('chat-input');
      const text = input.value.trim();
      if (!text) return;
      if (!realtimeSocket?.connected) return showToast("Realtime chat is still connecting.");
      realtimeSocket.emit("message:send", { roomId: activeRoomId, text });
      input.value = '';
    }

    // --- Call Authentication Logic ---
    function openCallAuthModal(roomName) {
      selectedCallRoom = roomName;
      document.getElementById('call-room-name-display').innerText = `Joining: ${roomName}`;
      document.getElementById('call-auth-modal').classList.remove('hidden');
    }

    function connectCall(callType = "video") {
      closeModals();
      if (!realtimeSocket?.connected) return showToast("Realtime calls are still connecting.");
      const target = getPreferredCallTarget();
      if (!target) return showToast("No manager is online for a call yet.");
      startDirectCall(target.id, callType);
    }

    // --- Settings & Online Status ---
    function toggleOnlineStatus() {
      isOnline = !isOnline;
      const btn = document.getElementById('toggle-online-btn');
      const indicator = document.getElementById('status-indicator');
      const text = document.getElementById('status-text');

      if (isOnline) {
        btn.className = "w-12 h-6 bg-blue-600 relative transition-colors duration-300";
        btn.querySelector('span').className = "absolute right-1 top-1 bg-white w-4 h-4 shadow-sm transition-all duration-300 transform";
        indicator.className = "w-1.5 h-1.5 bg-blue-500 inline-block";
        text.innerText = "Online";
        showToast("You are now visible as Online.");
      } else {
        btn.className = "w-12 h-6 bg-slate-300 relative transition-colors duration-300";
        btn.querySelector('span').className = "absolute left-1 top-1 bg-white w-4 h-4 shadow-sm transition-all duration-300 transform";
        indicator.className = "w-1.5 h-1.5 bg-slate-400 inline-block";
        text.innerText = "Offline";
        showToast("You are now hidden (Offline).");
      }
    }

    function toggleSetting(btn) {
      if (btn.classList.contains('bg-slate-300')) {
        btn.classList.remove('bg-slate-300');
        btn.classList.add('bg-blue-600');
        const span = btn.querySelector('span');
        span.classList.remove('left-1');
        span.classList.add('right-1');
      } else {
        btn.classList.remove('bg-blue-600');
        btn.classList.add('bg-slate-300');
        const span = btn.querySelector('span');
        span.classList.remove('right-1');
        span.classList.add('left-1');
      }
    }

    // --- Modals & General Utils ---
    function openEmployeeDirectory() {
      document.getElementById('employee-directory-modal').classList.remove('hidden');
    }

    function openProfileModal() {
      document.getElementById('profile-modal').classList.remove('hidden');
    }

    function closeModals() {
      document.querySelectorAll('.modal-bg').forEach(m => m.classList.add('hidden'));
    }

    function saveNotes() {
      localStorage.setItem('flowdesk_notes', document.getElementById('personal-notes').value);
      updateDashboardNotesPreview();
      showToast('Notes saved successfully');
    }

    function updateDashboardNotesPreview() {
      const notes = localStorage.getItem('flowdesk_notes') || '';
      const previewEl = document.getElementById('dash-quick-notes-preview');
      if (previewEl) {
        if (notes.trim() === '') {
          previewEl.innerHTML = '<span class="text-slate-400 italic">No notes saved yet.</span>';
        } else {
          previewEl.textContent = notes;
        }
      }
    }

    function logout() {
      showToast('Logging out of workspace...');
      setTimeout(() => { window.location.reload(); }, 1000);
    }

    function showToast(message) {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = 'toast';
      toast.innerHTML = `<i class="fas fa-info-circle text-blue-600"></i><span class="text-slate-700 font-medium">${message}</span>`;
      container.appendChild(toast);
      setTimeout(() => toast.classList.add('show'), 10);
      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
      }, 3000);
    }
