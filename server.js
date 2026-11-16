const express = require('express');
const cors = require('cors');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 7860;
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// In-memory store for active visitor sessions
// sessionId -> { sock, qr, status: 'init'|'qr'|'connected'|'closed', lastActive }
const sessions = new Map();

function cleanSessionId(id) {
  return String(id || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'default';
}

function formatE164(phone, defaultCountry = 'General') {
  if (!phone) return null;
  const raw = String(phone).trim();
  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  if (raw.startsWith('+') || raw.startsWith('00')) {
    if (digits.startsWith('00')) digits = digits.slice(2);
    return digits.length >= 9 ? digits : null;
  }

  const cLow = (defaultCountry || '').toLowerCase();
  if (cLow.includes('australia') || cLow === 'au' || cLow.startsWith('+61')) {
    if (digits.startsWith('0') && digits.length === 10) return '61' + digits.slice(1);
    if (digits.startsWith('4') && digits.length === 9) return '61' + digits;
    if (digits.startsWith('61') && digits.length >= 10) return digits;
  } else if (cLow.includes('usa') || cLow.includes('united states') || cLow === 'us' || cLow.includes('canada') || cLow.startsWith('+1')) {
    if (digits.length === 10) return '1' + digits;
    if (digits.length === 11 && digits.startsWith('1')) return digits;
  } else if (cLow.includes('pakistan') || cLow === 'pk' || cLow.startsWith('+92')) {
    if (digits.startsWith('0') && digits.length === 11) return '92' + digits.slice(1);
    if (digits.length === 10 && digits.startsWith('3')) return '92' + digits;
    if (digits.startsWith('92') && digits.length >= 11) return digits;
  } else if (cLow.includes('united kingdom') || cLow === 'uk' || cLow.startsWith('+44')) {
    if (digits.startsWith('0')) return '44' + digits.slice(1);
    if (digits.startsWith('44')) return digits;
  } else if (cLow.includes('uae') || cLow.includes('emirates') || cLow.includes('dubai') || cLow.startsWith('+971')) {
    if (digits.startsWith('0')) return '971' + digits.slice(1);
    if (digits.startsWith('971')) return digits;
  } else if (cLow.includes('india') || cLow.startsWith('+91')) {
    if (digits.startsWith('0') && digits.length === 11) return '91' + digits.slice(1);
    if (digits.length === 10) return '91' + digits;
  }

  // Intelligent Auto-Detect
  if (digits.startsWith('04') && digits.length === 10) return '61' + digits.slice(1);
  if (digits.startsWith('03') && digits.length === 11) return '92' + digits.slice(1);
  if (digits.startsWith('07') && digits.length === 11) return '44' + digits.slice(1);
  if (digits.length === 10) {
    if (digits.startsWith('3')) return '92' + digits;
    if (digits.startsWith('4')) return '61' + digits;
    return '1' + digits;
  }

  return digits.length >= 9 ? digits : null;
}

async function startSession(rawId) {
  const sid = cleanSessionId(rawId);
  const existing = sessions.get(sid);
  if (existing && (existing.status === 'connected' || existing.status === 'qr' || existing.status === 'init')) {
    existing.lastActive = Date.now();
    return existing;
  }

  const sessionFolder = path.join(SESSIONS_DIR, sid);
  if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });

  const stateObj = {
    id: sid,
    sock: null,
    qr: null,
    status: 'init',
    lastActive: Date.now()
  };
  sessions.set(sid, stateObj);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[Session ${sid}] Using WA v${version.join('.')} (isLatest=${isLatest})`);

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers.macOS('Desktop'),
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: undefined,
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    stateObj.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        try {
          stateObj.qr = await QRCode.toDataURL(qr);
          stateObj.status = 'qr';
        } catch (e) {}
      }
      if (connection === 'open') {
        stateObj.status = 'connected';
        stateObj.qr = null;
        console.log(`[Session ${sid}] Connected!`);
      } else if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut && code !== 401;
        console.log(`[Session ${sid}] Closed (code ${code}), reconnect=${shouldReconnect}`);
        if (shouldReconnect && sessions.has(sid)) {
          stateObj.status = 'init';
          setTimeout(() => startSession(sid), 1500);
        } else {
          stateObj.status = 'closed';
          stateObj.qr = null;
          sessions.delete(sid);
          try { fs.rmSync(sessionFolder, { recursive: true, force: true }); } catch (e) {}
        }
      }
    });
  } catch (err) {
    console.error(`[Session ${sid}] Error:`, err.message);
    stateObj.status = 'error';
  }

  return stateObj;
}

// Cleanup idle sessions older than 45 mins to save RAM
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions.entries()) {
    if (now - s.lastActive > 45 * 60 * 1000) {
      try { s.sock?.end(); } catch (e) {}
      sessions.delete(sid);
    }
  }
}, 5 * 60 * 1000);

// Health Check (keeps Render/Koyeb happy)
app.get('/', (req, res) => {
  res.json({
    service: 'WhatsVerifier Pro Cloud Engine',
    status: 'online',
    active_sessions: sessions.size
  });
});

// Start / Get QR for a specific visitor session
app.get('/api/session/qr', async (req, res) => {
  const sid = cleanSessionId(req.query.sessionId);
  const s = await startSession(sid);
  s.lastActive = Date.now();
  res.json({
    sessionId: sid,
    status: s.status,
    connected: s.status === 'connected',
    qr: s.qr
  });
});

// Check session status
app.get('/api/session/status', (req, res) => {
  const sid = cleanSessionId(req.query.sessionId);
  const s = sessions.get(sid);
  if (!s) {
    return res.json({ sessionId: sid, connected: false, status: 'disconnected', qr: null });
  }
  s.lastActive = Date.now();
  res.json({
    sessionId: sid,
    connected: s.status === 'connected',
    status: s.status,
    qr: s.qr
  });
});

// Disconnect / Logout session
app.post('/api/session/logout', async (req, res) => {
  const sid = cleanSessionId(req.body?.sessionId || req.query.sessionId);
  const s = sessions.get(sid);
  if (s) {
    try { await s.sock?.logout(); } catch (e) {}
    try { s.sock?.end(); } catch (e) {}
    sessions.delete(sid);
  }
  const sessionFolder = path.join(SESSIONS_DIR, sid);
  try { fs.rmSync(sessionFolder, { recursive: true, force: true }); } catch (e) {}
  res.json({ status: 'logged_out' });
});

// Verify single OR batch numbers (Ultra-fast via Baileys onWhatsApp)
app.post('/api/verify', async (req, res) => {
  const sid = cleanSessionId(req.body?.sessionId || req.query.sessionId);
  const country = req.body?.country || 'General';
  let numbers = req.body?.numbers;
  if (!numbers && req.body?.phone) numbers = [req.body.phone];

  const s = sessions.get(sid);
  if (!s || s.status !== 'connected' || !s.sock) {
    return res.status(400).json({ error: 'WhatsApp not connected. Please scan QR code first.' });
  }
  s.lastActive = Date.now();

  if (!Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: 'No numbers provided.' });
  }

  const results = [];
  for (const raw of numbers) {
    const t0 = Date.now();
    const clean = formatE164(raw, country);
    if (!clean) {
      results.push({
        phone: raw,
        formatted: String(raw),
        is_active: false,
        status: 'Invalid Number Format',
        duration: 0.1
      });
      continue;
    }

    try {
      const [check] = await s.sock.onWhatsApp(`${clean}@s.whatsapp.net`);
      const isActive = !!(check && check.exists);
      const dur = Math.max(0.1, Number(((Date.now() - t0) / 1000).toFixed(2)));
      results.push({
        phone: raw,
        formatted: '+' + clean,
        is_active: isActive,
        status: isActive ? 'Active on WhatsApp' : 'Not on WhatsApp',
        duration: dur
      });
    } catch (err) {
      results.push({
        phone: raw,
        formatted: '+' + clean,
        is_active: false,
        status: 'Check Failed',
        duration: 0.2
      });
    }
  }

  res.json({ results });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`WhatsVerifier Cloud Engine running on port ${PORT}`);
});
