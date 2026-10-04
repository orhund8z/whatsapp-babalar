const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
const { setQR, clearQR, setWhatsAppStatus, postLog } = require("./api-client");

function formatError(err) {
  if (!err) return "Unknown error";
  if (err.stack) return err.stack;
  if (err.message) return err.message;
  try {
    return JSON.stringify(err);
  } catch (_) {
    return String(err);
  }
}

function logInfo(message) {
  console.log(message);
  postLog("INFO", message).catch(() => {});
}

function logWarn(message) {
  console.warn(message);
  postLog("WARN", message).catch(() => {});
}

function logError(message) {
  console.error(message);
  postLog("ERROR", message).catch(() => {});
}

function clearChromiumLocks(sessionPath) {
  const patterns = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
  try {
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        if (patterns.includes(f)) {
          fs.unlinkSync(full);
          console.log(`[whatsapp] Removed lock: ${full}`);
        } else if (fs.statSync(full).isDirectory()) {
          walk(full);
        }
      }
    };
    walk(sessionPath);
  } catch (e) {}
}

async function initWhatsApp() {
  clearChromiumLocks("./session");

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: "./session" }),
    puppeteer: {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      headless: true,
      protocolTimeout: 0, // no CDP-level timeout — rely on app-level timeout in scheduler.js
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ],
    },
  });

  client.on("qr", async (qr) => {
    console.log("\n[whatsapp] Scan QR code:");
    qrcode.generate(qr, { small: true });
    try {
      const dataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
      await setQR(dataUrl);
      logInfo("[whatsapp] QR posted to backend. Open Admin > WhatsApp Groups and scan the displayed code.");
    } catch (e) {
      logWarn(`[whatsapp] Could not post QR to backend:\n${formatError(e)}`);
    }
  });

  client.on("authenticated", async () => {
    logInfo("[whatsapp] Session authenticated.");
    try { await clearQR(); } catch (_) {}
    try { await setWhatsAppStatus("connected"); } catch (_) {}
  });

  client.on("auth_failure", async (msg) => {
    logError(`[whatsapp] Auth failure: ${msg || "unknown"}`);
    try { await setWhatsAppStatus("auth_failure"); } catch (_) {}
    process.exit(1);
  });

  client.on("disconnected", async (reason) => {
    logWarn(`[whatsapp] Disconnected: ${reason || "unknown"}`);
    try { await setWhatsAppStatus("disconnected"); } catch (_) {}
    if (reason === "LOGOUT") {
      logWarn("[whatsapp] LOGOUT detected — clearing session and restarting...");
      try { fs.rmSync("./session", { recursive: true, force: true }); } catch (_) {}
      process.exit(1);
    }
  });

  await new Promise((resolve) => {
    client.on("ready", async () => {
      logInfo("[whatsapp] Connected. Waiting for sync (60s)...");
      // Disable page-level timeouts — getChats() on large accounts can take many minutes.
      // We rely on our own application-level timeout in scheduler.js instead.
      try { client.pupPage.setDefaultTimeout(0); } catch (_) {}
      await new Promise((r) => setTimeout(r, 60000));
      logInfo("[whatsapp] Ready.");
      resolve();
    });
    client.initialize();
  });

  return client;
}

// Fetch messages from a group, loading incrementally until we reach the `since` date.
// Avoids loading the entire history at once which can OOM the browser on t4g.small (2GB RAM).
async function* streamGroupMessages(chat, since, cancelFn) {
  const PAGE_SIZE = 100;
  const STEP = 500;       // messages to add each round
  const MAX_MSGS = 20000; // hard ceiling — ~200 days for a 100 msg/day group
  const sinceTs = Math.floor(since.getTime() / 1000); // WA timestamps are in seconds

  let all = [];
  let limit = STEP;

  while (limit <= MAX_MSGS) {
    // Race fetchMessages against a periodic cancel poll (every 3s)
    // so cancel fires even while a single batch is in-flight.
    let pollTimer;
    const cancelRace = cancelFn
      ? new Promise((_, reject) => {
          const poll = async () => {
            if (await cancelFn()) { reject(new Error("CANCELLED")); return; }
            pollTimer = setTimeout(poll, 3000);
          };
          pollTimer = setTimeout(poll, 3000);
        })
      : null;

    let batch;
    try {
      batch = cancelRace
        ? await Promise.race([chat.fetchMessages({ limit }), cancelRace])
        : await chat.fetchMessages({ limit });
    } finally {
      clearTimeout(pollTimer);
    }
    // fetchMessages returns in chronological order; batch[0] is oldest
    const oldestTs = batch.length ? batch[0].timestamp : Infinity;
    const prevLen = all.length;
    all = batch;

    console.log(`[whatsapp] "${chat.name}": loaded ${batch.length} (limit=${limit}), oldest=${new Date(oldestTs * 1000).toISOString().slice(0, 10)}`);

    // Stop if we've reached or passed the since date, or no new messages came in
    if (oldestTs <= sinceTs || batch.length === prevLen || batch.length < limit) break;

    limit += STEP;
  }

  const filtered = [];
  for (const msg of all) {
    if (msg.timestamp <= sinceTs) continue;
    if (msg.body && msg.body.trim().length >= 10) {
      filtered.push({
        sender_name: msg._data.notifyName || msg.author || null,
        content: msg.body,
        sent_at: new Date(msg.timestamp * 1000).toISOString(),
      });
    }
  }

  console.log(`[whatsapp] "${chat.name}": ${all.length} in cache, ${filtered.length} new after ${since.toISOString().slice(0, 10)}.`);

  for (let i = 0; i < filtered.length; i += PAGE_SIZE) {
    yield filtered.slice(i, i + PAGE_SIZE);
  }
}

module.exports = { initWhatsApp, streamGroupMessages };
