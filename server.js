const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const pino = require("pino");
const QRCode = require("qrcode");
const { Server } = require("socket.io");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e6 });
const PORT = Number(process.env.PORT || 3000);
// Keep this local unless you add real authentication and HTTPS.
const HOST = process.env.HOST || "127.0.0.1";
const AUTH_DIR = path.join(__dirname, "auth_data_local");
const PUBLIC_DIR = path.join(__dirname, "public");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/health", (_req, res) => res.json({
  ok: true,
  mode: "local-no-login",
  whatsappConnected: Boolean(waSocket?.user)
}));

let waSocket = null;
let waStarting = false;
let sendJob = null;
let sendStopRequested = false;
let sendPaused = false;

function emitStatus(message) {
  io.emit("status", String(message));
}
function normalizePhone(raw, countryCode = "94") {
  let digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = String(countryCode) + digits.slice(1);
  else if (digits.length <= 10 && countryCode && !digits.startsWith(String(countryCode))) {
    digits = String(countryCode) + digits;
  }
  return digits;
}
function parseContacts(content, countryCode = "94") {
  const text = String(content || "");
  const values = [];
  const seen = new Set();
  // Parse vCard TEL fields and plain-text phone numbers.
  const telMatches = text.match(/(?:^|\r?\n)\s*TEL[^:\r\n]*:([^\r\n]+)/gim) || [];
  for (const line of telMatches) {
    const value = line.slice(line.indexOf(":") + 1).trim();
    const number = normalizePhone(value, countryCode);
    if (number && number.length >= 7 && number.length <= 15 && !seen.has(number)) {
      seen.add(number);
      values.push(number);
    }
  }
  if (values.length === 0) {
    for (const line of text.split(/\r?\n/)) {
      const candidate = line.trim();
      if (!candidate || candidate.startsWith("#") || candidate.includes("@")) continue;
      const digits = candidate.replace(/[^\d+]/g, "");
      if (digits.replace(/\D/g, "").length < 7) continue;
      const number = normalizePhone(digits, countryCode);
      if (number && number.length >= 7 && number.length <= 15 && !seen.has(number)) {
        seen.add(number);
        values.push(number);
      }
    }
  }
  return values.slice(0, 500);
}
async function startWhatsApp(socket, phone) {
  if (waStarting) {
    socket.emit("status", "WhatsApp connection is already starting.");
    return;
  }
  if (waSocket?.user) {
    socket.emit("wa_connected", { user: waSocket.user.id });
    socket.emit("status", "WhatsApp is already connected.");
    return;
  }
  waStarting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    waSocket = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["Safe Sender Local", "Chrome", "1.0.0"]
    });
    waSocket.ev.on("creds.update", saveCreds);
    waSocket.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
      if (connection === "open") {
        waStarting = false;
              emitStatus("WhatsApp connected successfully.");
        io.emit("wa_connected", { user: waSocket?.user?.id || "" });
      }
      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        waSocket = null;
        waStarting = false;
        if (code === DisconnectReason.loggedOut) {
          emitStatus("WhatsApp session logged out. Remove auth_data_local only if you want to pair again.");
        } else {
          emitStatus("WhatsApp disconnected. Click Connect WhatsApp to retry.");
        }
      }
    });
    if (!state.creds.registered) {
      socket.emit("status", "QR ready when shown. Open WhatsApp > Linked devices > Link a device and scan it.");
    }
  } catch (error) {
    waSocket = null;
    waStarting = false;
    socket.emit("status", `WhatsApp connection failed: ${error.message}`);
  }
}

io.on("connection", socket => {
  socket.emit("app_ready", {
    whatsappConnected: Boolean(waSocket?.user),
    user: waSocket?.user?.id || ""
  });

  socket.on("request_qr", async () => {
    await startWhatsApp(socket, "");
  });

  socket.on("connect_whatsapp", async () => {
    await startWhatsApp(socket, "");
  });

  socket.on("parse_vcf", payload => {
    const countryCode = String(payload?.countryCode || "94").replace(/\D/g, "") || "94";
    const contacts = parseContacts(payload?.content, countryCode);
    socket.emit("contacts_parsed", contacts);
    socket.emit("status", `Loaded ${contacts.length} unique phone numbers. Select only people who agreed to receive your message.`);
  });

  socket.on("start_selected_send", async payload => {
    if (sendJob) {
      socket.emit("status", "A sending job is already running.");
      return;
    }
    if (!waSocket?.user) {
      socket.emit("status", "Connect WhatsApp first.");
      return;
    }
    if (payload?.confirmedOptIn !== true) {
      socket.emit("status", "Please confirm that every selected recipient agreed to receive messages.");
      return;
    }
    const recipients = Array.isArray(payload?.recipients)
      ? [...new Set(payload.recipients.map(n => String(n).replace(/\D/g, "")).filter(n => n.length >= 7 && n.length <= 15))]
      : [];
    const message = String(payload?.message || "").trim();
    if (!message || recipients.length === 0) {
      socket.emit("status", "Choose at least one valid contact and enter a message.");
      return;
    }
    if (recipients.length > 50) {
      socket.emit("status", "Select no more than 50 recipients per run.");
      return;
    }
    sendJob = true;
    sendStopRequested = false;
    sendPaused = false;
    let sent = 0;
    let failed = 0;
    socket.emit("send_progress", { current: 0, total: recipients.length, sent, failed, number: "" });
    try {
      for (const number of recipients) {
        while (sendPaused && !sendStopRequested) await delay(250);
        if (sendStopRequested) break;
        try {
          const jid = `${number}@s.whatsapp.net`;
          await waSocket.sendMessage(jid, { text: message });
          sent++;
          socket.emit("send_progress", { current: sent + failed, total: recipients.length, sent, failed, number, action: "sent" });
        } catch (error) {
          failed++;
          socket.emit("send_progress", { current: sent + failed, total: recipients.length, sent, failed, number, action: "failed" });
        }
        // Deliberate conservative delay to avoid rapid-fire sends.
        await delay(4000);
      }
    } finally {
      sendJob = null;
      sendPaused = false;
      socket.emit("send_done", { sent, failed, stopped: sendStopRequested });
      socket.emit("status", `Finished. Sent: ${sent}; failed: ${failed}${sendStopRequested ? "; stopped early" : ""}.`);
    }
  });

  socket.on("pause_send", () => { sendPaused = true; socket.emit("status", "Sending paused."); });
  socket.on("resume_send", () => { sendPaused = false; socket.emit("status", "Sending resumed."); });
  socket.on("stop_send", () => { sendStopRequested = true; sendPaused = false; socket.emit("status", "Stopping after the current message."); });
});

server.listen(PORT, HOST, () => {
  console.log(`Safe Sender local dashboard: http://${HOST}:${PORT}`);
  console.log("No login or MongoDB is used. Keep the server local and message only opted-in recipients.");
});
