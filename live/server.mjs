// Chánh Điện Tịnh Tâm — live server
// Runs on the streaming PC. Serves the overlay + control panel, listens to a TikTok LIVE room,
// keeps the list of seated viewers, generates Vietnamese voice lines with Edge TTS and pushes
// everything to the overlay over WebSocket.
//
//   cd live && npm install && node server.mjs        → http://localhost:3000/live/control.html
//
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');            // repo root: serves /assets, /live
const TTS_DIR = path.join(__dirname, 'tts');
fs.mkdirSync(TTS_DIR, { recursive: true });
for (const f of fs.readdirSync(TTS_DIR)) { try { fs.unlinkSync(path.join(TTS_DIR, f)); } catch {} }
const PORT = +process.env.PORT || 3000;

/* ------------------------------------------------------------------ state */
const settings = {
  title: 'Chánh Điện Tịnh Tâm',
  subtitle: 'Nam Mô A Di Đà Phật',
  voice: 'vi-VN-NamMinhNeural',      // or vi-VN-HoaiMyNeural
  pitch: -18,                        // Hz
  rate: -20,                         // %
  music: true, mo: true, moBpm: 52,
  autoChant: true, chantEveryMin: 3,
  seatMode: 'auto',                  // auto | 24 | 36 | 64 | 100
  joinOnEnter: false,                // also seat viewers who only enter the room
  gifts: { readAll: true, minDiamonds: 1 },
};
const viewers = new Map();           // id -> { id, name, skin, avatar, coins, joinedAt, lastAt, lastText, lastTextAt, demo }
const startedAt = Date.now();
let tiktok = null, tiktokState = { status: 'idle', uniqueId: '', error: '' };
const log = [];
function addLog(s){ const line = `[${new Date().toLocaleTimeString('vi-VN')}] ${s}`; log.push(line); if (log.length > 300) log.shift(); broadcast({ t:'log', line }, 'control'); console.log(line); }

const CAPS = [24, 36, 64, 100];
function capacity(){ if (settings.seatMode !== 'auto') return +settings.seatMode; const n = viewers.size; return CAPS.find(c => n <= c) || 100; }

/* skins: sprites that exist in /assets. Walking strips exist for man / woman / granny. */
// A comment changes the outfit only when it IS the keyword (≤ 3 words), so "Nam mô A Di Đà Phật" never reads as "nam".
const SKIN_WORDS = [
  ['master', ['cao tăng','cao tang']], ['monk', ['sư','su','sư thầy','su thay','thầy','thay']], ['nun', ['ni','ni cô','ni co','sư cô','su co']],
  ['child', ['tiểu','tieu','chú tiểu','chu tieu','bé','be']], ['granny', ['bà','ba','áo nâu','ao nau','cụ','cu']],
  ['woman', ['nữ','nu','chị','chi','gái','gai']], ['man', ['nam','anh','trai']],
];
function skinFromText(t){
  const w = String(t).toLowerCase().normalize('NFC').replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!w || w.split(' ').length > 3) return null;
  for (const [skin, words] of SKIN_WORDS) if (words.some(k => w === k || w.startsWith(k + ' '))) return skin;
  return null;
}
const DEFAULT_SKINS = ['man', 'woman', 'woman', 'man', 'granny'];

function pub(v){ return { id:v.id, name:v.name, skin:v.skin, avatar:v.avatar||'', coins:v.coins, demo:!!v.demo }; }
function snapshot(){ return { t:'state', settings, viewers:[...viewers.values()].map(pub), cap: capacity(), startedAt, tiktok: tiktokState }; }

// TikTok events sometimes come without uniqueId/userId
const viewerId = (id, name) => String(id ?? '') || 'anon_' + String(name || '');
function seat(id, name, opts = {}){
  id = viewerId(id, name);
  let v = viewers.get(id);
  if (v){ v.lastAt = Date.now(); if (opts.avatar) v.avatar = opts.avatar; return { v, isNew:false }; }
  if (viewers.size >= 100){                     // full: the longest-quiet non-donor stands up
    const quiet = [...viewers.values()].filter(x => x.coins === 0).sort((a,b) => a.lastAt - b.lastAt)[0];
    if (!quiet) return { v:null, isNew:false };
    viewers.delete(quiet.id); broadcast({ t:'leave', id: quiet.id });
  }
  v = { id, name: (name||id).slice(0, 18), skin: opts.skin || DEFAULT_SKINS[viewers.size % DEFAULT_SKINS.length],
        avatar: opts.avatar || '', coins: 0, joinedAt: Date.now(), lastAt: Date.now(), demo: !!opts.demo };
  viewers.set(id, v);
  broadcast({ t:'join', v: pub(v), cap: capacity() });
  return { v, isNew:true };
}

/* ------------------------------------------------------------- events in */
function onChat(id, name, text, avatar){
  id = viewerId(id, name);
  text = String(text || '').slice(0, 120);
  const want = skinFromText(text);
  const { v, isNew } = seat(id, name, { avatar, skin: want || undefined });
  if (!v) return;
  if (!isNew && want && want !== v.skin){ v.skin = want; broadcast({ t:'skin', id, skin: want }); }
  v.lastText = text; v.lastTextAt = Date.now();
  broadcast({ t:'chat', id, name: v.name, text });
}

function onGift(id, name, giftName, count, diamonds, avatar){
  id = viewerId(id, name);
  giftName = String(giftName || 'quà').slice(0, 30); count = Math.max(1, Math.min(9999, +count || 1));
  const { v } = seat(id, name, { avatar });
  if (!v) return;
  const coins = Math.max(1, (diamonds || 1) * (count || 1));
  v.coins += coins;
  const prayer = (v.lastText && Date.now() - v.lastTextAt < 90_000 && v.lastText.length > 6) ? v.lastText : pickPrayer();
  const tier = coins >= 99 ? 3 : coins >= 10 ? 2 : 1;
  const line = `Nam mô A Di Đà Phật. Phật tử ${spoken(v.name)} thành tâm dâng ${giftName}${count > 1 ? ', ' + count + ' lần' : ''}. ${prayer}.`;
  broadcast({ t:'gift', id, name: v.name, giftName, count, coins, total: v.coins, tier, prayer });
  if (settings.gifts.readAll || coins >= settings.gifts.minDiamonds) say(line, { tag:'gift', id });
}

function pickPrayer(){
  const P = ['Nguyện cầu gia đạo bình an, vạn sự cát tường', 'Nguyện cầu cha mẹ mạnh khỏe, sống lâu', 'Nguyện hồi hướng công đức cho khắp pháp giới chúng sinh',
             'Nguyện cầu thân tâm an lạc, phiền não tiêu trừ', 'Nguyện cầu công việc hanh thông, gia đình hạnh phúc'];
  return P[Math.floor(Math.random() * P.length)];
}
const spoken = s => String(s).replace(/[_@.]+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').trim() || 'ẩn danh';

/* ------------------------------------------------------------------ TTS */
const ttsQueue = []; let ttsBusy = false, ttsSeq = 0;
function esc(s){ return String(s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c])); }
function say(text, meta = {}){ if (ttsQueue.length >= 15) { addLog('Hàng đợi giọng đọc đầy, bỏ qua 1 câu'); return; } ttsQueue.push({ text: String(text).slice(0, 500), meta }); pumpTTS(); }
// Optional proxy for the Edge voice (Microsoft may throttle one home IP):
//   TTS_PROXY      fixed proxy, "http://user:pass@host:port" or "host:port:user:pass"
//   TTS_PROXY_KEY  TopProxy / proxyxoay.shop rotating key; a fresh IP is fetched every 70 s or after a failed call
// The key can also be entered on the control panel; it is kept in live/.env.local (git-ignored, never served,
// never sent to overlays) so it survives a restart.
const proxyUrl = raw => { const s = String(raw).trim().replace(/:+$/, ''); if (/^\w+:\/\//.test(s)) return s;
  const [h, p, u, pw] = s.split(':'); return u ? `http://${encodeURIComponent(u)}:${encodeURIComponent(pw || '')}@${h}:${p}` : `http://${h}:${p}`; };
const maskProxy = u => String(u).replace(/\/\/[^@]*@/, '//***@');
const maskKey = k => k ? (k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-3)}` : '***') : '';
const LOCAL_ENV = path.join(__dirname, '.env.local');
const savedKey = (() => { try { return (fs.readFileSync(LOCAL_ENV, 'utf8').match(/^TTS_PROXY_KEY=(.*)$/m) || [])[1]?.trim() || ''; } catch { return ''; } })();
const ttsProxy = { fixed: process.env.TTS_PROXY || '', key: process.env.TTS_PROXY_KEY || savedKey, url: '', at: 0, failAt: 0, Agent: null, message: '',
  status(){ return { t:'proxy', mode: this.fixed ? 'fixed' : this.key ? 'key' : 'off', key: maskKey(this.key), proxy: this.url ? maskProxy(this.url) : '', message: this.message }; },
  report(){ broadcast(this.status(), 'control'); },
  async setKey(key){
    this.key = String(key || '').trim().slice(0, 200); this.url = ''; this.at = 0; this.failAt = 0; this.message = '';
    try { fs.writeFileSync(LOCAL_ENV, this.key ? `TTS_PROXY_KEY=${this.key}\n` : ''); } catch (e) { addLog('Không lưu được key proxy: ' + e.message); }
    addLog(this.key ? `Đã đặt key proxy xoay ${maskKey(this.key)}` : 'Đã tắt proxy giọng đọc, gọi thẳng Microsoft');
    if (this.key) await this.agent(true); else this.report();
  },
  async agent(rotate = false){
    if (!this.fixed && !this.key) return null;
    if (!this.fixed && !this.url && Date.now() - this.failAt < 60_000) return null;   // bad key / API down: go direct for a minute
    this.Agent ||= (await import('https-proxy-agent')).HttpsProxyAgent;
    if (this.fixed) { this.url ||= proxyUrl(this.fixed); return new this.Agent(this.url); }
    if (rotate || !this.url || Date.now() - this.at > 70_000) {
      try {
        const ip = (await (await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) })).json()).ip || '';
        const res = await fetch(`https://proxyxoay.shop/api/get.php?key=${encodeURIComponent(this.key)}&nhamang=random&tinhthanh=0&whitelist=${encodeURIComponent(ip)}`,
          { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15_000) });
        const d = await res.json(); const raw = d.proxyhttp || d.proxy_http;
        if (raw) { this.url = proxyUrl(raw); this.at = Date.now(); this.message = d['Vi Tri'] || 'đang dùng'; addLog(`Proxy giọng đọc: ${maskProxy(this.url)}${d['Vi Tri'] ? ' (' + d['Vi Tri'] + ')' : ''}`); }
        else { this.message = d.message || 'status ' + d.status; if (!this.url) { this.failAt = Date.now(); addLog(`Không lấy được proxy xoay: ${this.message}`); } }
      } catch (e) { this.message = e.message; if (!this.url) { this.failAt = Date.now(); addLog('Không lấy được proxy xoay: ' + e.message); } }
      this.report();
    }
    return this.url ? new this.Agent(this.url) : null;
  } };
async function edgeTTS(text, agent = null){
  const tts = new MsEdgeTTS(agent ? { agent } : undefined);
  try {
    await tts.setMetadata(settings.voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(esc(text), { pitch: `${settings.pitch >= 0 ? '+' : ''}${settings.pitch}Hz`, rate: `${settings.rate >= 0 ? '+' : ''}${settings.rate}%` });
    const chunks = [];
    await new Promise((res, rej) => { audioStream.on('data', c => chunks.push(c)); audioStream.on('close', res); audioStream.on('error', rej); });
    return Buffer.concat(chunks);
  } finally { try { tts.close(); } catch {} }
}
async function pumpTTS(){
  if (ttsBusy || !ttsQueue.length) return; ttsBusy = true;
  const { text, meta } = ttsQueue.shift();
  let audio = null, ext = 'mp3', lastErr = null;
  // the free Edge endpoint often drops the stream before the first byte: retry (through the proxy, on a fresh
  // proxy IP after a failure, last try direct), then fall back to local ZeroTTS
  for (let attempt = 0; attempt < 3 && !audio; attempt++) {
    const agent = attempt < 2 ? await ttsProxy.agent(attempt > 0) : null;
    try { audio = await edgeTTS(text, agent); } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 800)); }
  }
  if (!audio && zeroTTS.ready) {
    try { audio = await zeroTTS.synth(text); ext = 'wav'; addLog('Giọng Edge lỗi, đã đọc bằng giọng dự phòng ZeroTTS'); }
    catch (e) { lastErr = e; }
  }
  if (audio) {
    const file = `tts_${Date.now()}_${++ttsSeq}.${ext}`;
    fs.writeFileSync(path.join(TTS_DIR, file), audio);
    broadcast({ t:'tts', url: `/live/tts/${file}`, text, ...meta });
    const old = fs.readdirSync(TTS_DIR).sort(); while (old.length > 40) { try { fs.unlinkSync(path.join(TTS_DIR, old.shift())); } catch {} }
  } else addLog('TTS lỗi: ' + (lastErr?.message || lastErr));
  ttsBusy = false; setTimeout(pumpTTS, 50);
}

// Optional offline fallback voice: set ZEROTTS_DIR to a folder holding tts_worker.py and a .venv with zerotts installed
// (see tiktok-live-temple-rpc). The worker reads {"id","text","voice"} lines on stdin and answers JSON lines on stdout.
const zeroTTS = { ready: false, proc: null, pending: new Map(), seq: 0, buf: '', dir: process.env.ZEROTTS_DIR || '',
  start(){
    const py = path.join(this.dir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const script = path.join(this.dir, 'tts_worker.py');
    if (!this.dir || !fs.existsSync(py) || !fs.existsSync(script)) return;
    this.proc = spawn(py, [script], { cwd: this.dir, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc.stdout.on('data', c => {
      this.buf += c.toString('utf8'); const lines = this.buf.split('\n'); this.buf = lines.pop();
      for (const l of lines) { let m; try { m = JSON.parse(l); } catch { continue; }
        if (m.type === 'ready') { this.ready = true; addLog(`Giọng dự phòng ZeroTTS sẵn sàng (${m.voice})`); }
        else if (m.type === 'result') { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m); } } }
    });
    this.proc.on('exit', () => { this.ready = false; for (const p of this.pending.values()) p({ ok:false, error:'ZeroTTS worker exited' }); this.pending.clear(); });
  },
  synth(text){
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('ZeroTTS timeout')); }, 30_000);
      this.pending.set(id, m => { clearTimeout(timer);
        if (!m.ok) return reject(new Error(m.error || 'ZeroTTS failed'));
        try { resolve(fs.readFileSync(path.join(this.dir, 'data', 'tts-cache', m.file))); } catch (e) { reject(e); } });
      this.proc.stdin.write(JSON.stringify({ id, text, voice: 'maichi' }) + '\n');
    });
  } };
zeroTTS.start();

const CHANTS = [
  'Nam mô Bổn Sư Thích Ca Mâu Ni Phật. Nguyện đem công đức này, hướng về khắp tất cả, đệ tử và chúng sinh, đều trọn thành Phật đạo.',
  'Nam mô A Di Đà Phật. Nguyện sanh Tây Phương Tịnh Độ trung, cửu phẩm liên hoa vi phụ mẫu.',
  'Nam mô Đại Bi Quán Thế Âm Bồ Tát. Nguyện cho tất cả chúng sinh thân tâm an lạc, tai qua nạn khỏi.',
  'Quán Tự Tại Bồ Tát hành thâm Bát Nhã Ba La Mật Đa thời, chiếu kiến ngũ uẩn giai không, độ nhất thiết khổ ách.',
];
let chantIdx = 0, chantTimer = null;
function chant(){ const text = CHANTS[chantIdx++ % CHANTS.length]; broadcast({ t:'chant', text }); say(text, { tag:'chant' }); }
function scheduleChant(){ clearInterval(chantTimer); if (settings.autoChant) chantTimer = setInterval(chant, Math.max(1, settings.chantEveryMin) * 60_000); }
scheduleChant();

/* --------------------------------------------------------------- TikTok */
let TikTokLib = null;
async function connectTikTok(uniqueId){
  uniqueId = String(uniqueId || '').trim().replace(/^.*tiktok\.com\/@?/i, '').replace(/^@/, '').replace(/\/.*$/, '');
  if (!uniqueId) return;
  await disconnectTikTok();
  tiktokState = { status: 'connecting', uniqueId, error: '' }; broadcast({ t:'tiktok', ...tiktokState });
  try {
    TikTokLib ||= await import('tiktok-live-connector');
    const { TikTokLiveConnection, WebcastEvent, ControlEvent } = TikTokLib;
    // extended gift info and room-info-on-connect need a paid EulerStream plan; giftDetails already carries diamondCount
    const conn = new TikTokLiveConnection(uniqueId, { enableExtendedGiftInfo: false, fetchRoomInfoOnConnect: false, processInitialData: false });
    const av = u => u?.profilePicture?.url?.[0] || u?.profilePicture?.urlList?.[0] || u?.avatarThumb?.urlList?.[0] || u?.avatarThumb?.url?.[0] || '';
    const nm = u => u?.nickname || u?.uniqueId || 'ẩn danh';
    conn.on(WebcastEvent.CHAT, d => onChat(d.user?.uniqueId || d.user?.userId, nm(d.user), d.comment, av(d.user)));
    conn.on(WebcastEvent.GIFT, d => {
      const type = d.giftDetails?.giftType ?? d.extendedGiftInfo?.type;
      if (type === 1 && !d.repeatEnd) return;                       // streak still running
      const gname = d.giftDetails?.giftName || d.extendedGiftInfo?.name || 'quà';
      const dia = d.giftDetails?.diamondCount ?? d.extendedGiftInfo?.diamond_count ?? 1;
      onGift(d.user?.uniqueId || d.user?.userId, nm(d.user), gname, d.repeatCount || 1, dia, av(d.user));
      addLog(`🎁 ${nm(d.user)} tặng ${gname} x${d.repeatCount || 1}`);
    });
    conn.on(WebcastEvent.MEMBER, d => { if (settings.joinOnEnter) seat(d.user?.uniqueId, nm(d.user), { avatar: av(d.user) }); });
    conn.on(WebcastEvent.LIKE, d => broadcast({ t:'like', id: d.user?.uniqueId, n: d.likeCount || 1 }));
    conn.on(ControlEvent.DISCONNECTED, () => { tiktokState = { ...tiktokState, status: 'disconnected' }; broadcast({ t:'tiktok', ...tiktokState }); addLog('TikTok: mất kết nối'); });
    conn.on(ControlEvent.ERROR, e => addLog('TikTok lỗi: ' + (e?.info || e?.message || e)));
    const st = await conn.connect();
    tiktok = conn;
    tiktokState = { status: 'connected', uniqueId, error: '', roomId: st?.roomId || '' };
    addLog(`✅ Đã kết nối live @${uniqueId}`);
  } catch (e) {
    tiktokState = { status: 'error', uniqueId, error: String(e?.message || e) };
    addLog(`❌ Không kết nối được @${uniqueId}: ${tiktokState.error}`);
  }
  broadcast({ t:'tiktok', ...tiktokState });
}
async function disconnectTikTok(){ if (tiktok){ try { await tiktok.disconnect(); } catch {} tiktok = null; } tiktokState = { status:'idle', uniqueId:'', error:'' }; broadcast({ t:'tiktok', ...tiktokState }); }

/* ------------------------------------------------------------- test data */
const DEMO_NAMES = ['Diệu Hạnh','Minh Tâm','Thiện Đức','Huệ An','Tịnh Nhã','Quảng Trí','Chơn Như','Pháp Hỷ','Nguyên Thanh','Tâm Đăng','Diệu Liên','Trí Hải','Phước Lộc','Hạnh Nguyện','Như Ý','Bảo Châu','Thanh Lương','Từ Tâm','An Lạc','Giác Hoa','Tuệ Minh','Liên Hương','Thu Hà','Ngọc Lan','Đức Anh','Hải Đăng','Mai Anh','Phương Thảo','Trung Kiên','Quang Huy','Bảo Ngọc','Diệu Linh'];
function fillDemo(n){
  const have = [...viewers.values()].filter(v => v.demo).length;
  for (let i = have; i < n && viewers.size < 100; i++){
    const name = DEMO_NAMES[i % DEMO_NAMES.length] + (i >= DEMO_NAMES.length ? ' ' + (Math.floor(i / DEMO_NAMES.length) + 1) : '');
    seat('demo_' + i, name, { demo: true, skin: ['man','woman','woman','man','granny','monk','nun','child'][i % 8] });
  }
}
function clearSeats(){ viewers.clear(); broadcast(snapshot()); addLog('Đã làm trống bồ đoàn'); }

/* ------------------------------------------------------------- control */
function onControl(m){
  switch (m.cmd){
    case 'connect': connectTikTok(m.uniqueId); break;
    case 'disconnect': disconnectTikTok(); addLog('Đã ngắt kết nối TikTok'); break;
    case 'chat': { const n = String(m.name || 'Khách').slice(0, 18); onChat('sim_' + n, n, String(m.text || 'Nam mô A Di Đà Phật').slice(0, 120)); break; }
    case 'gift': { const n = String(m.name || 'Khách').slice(0, 18); onGift('sim_' + n, n, String(m.gift || 'Hoa hồng').slice(0, 30), clamp(m.count, 1, 99), clamp(m.diamonds, 1, 50000)); break; }
    case 'fill': fillDemo(clamp(m.n, 1, 100)); addLog(`Đổ người mẫu: ${viewers.size} người`); break;
    case 'clear': clearSeats(); break;
    case 'bell': broadcast({ t:'bell' }); break;
    case 'mo': broadcast({ t:'mo1' }); break;
    case 'chant': chant(); break;
    case 'say': if (m.text) say(String(m.text).slice(0, 400), { tag:'say' }); break;
    case 'proxyKey': ttsProxy.setKey(m.key); break;
    case 'settings':
      applySettings(m.settings || {});
      scheduleChant(); broadcast({ t:'settings', settings, cap: capacity() }); break;
    case 'bots': setBots(!!m.on, +m.n || 12, m.pace); break;
  }
}

// Only known keys, right types, sane ranges: the panel is local, but nothing from the socket is trusted blindly.
const SETTING_RULES = {
  title: v => String(v).slice(0, 40), subtitle: v => String(v).slice(0, 60),
  voice: v => ['vi-VN-NamMinhNeural', 'vi-VN-HoaiMyNeural'].includes(v) ? v : settings.voice,
  pitch: v => clamp(v, -50, 50), rate: v => clamp(v, -50, 50), moBpm: v => clamp(v, 20, 120), chantEveryMin: v => clamp(v, 1, 60),
  music: Boolean, mo: Boolean, autoChant: Boolean, joinOnEnter: Boolean,
  seatMode: v => ['auto', '24', '36', '64', '100'].includes(String(v)) ? String(v) : 'auto',
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(+v || 0)));
function applySettings(o){ for (const [k, fn] of Object.entries(SETTING_RULES)) if (k in o) settings[k] = fn(o[k]); }

/* ----------------------------------------------------------------- bots */
let botTimer = null;
const BOT_LINES = ['Nam mô A Di Đà Phật', 'Nam mô Bổn Sư Thích Ca Mâu Ni Phật', 'Cầu cho gia đình bình an', 'Con xin thành tâm sám hối', 'nữ', 'nam', 'bà',
  'Nguyện cầu cha mẹ mạnh khỏe', 'Mô Phật, an lạc quá', 'Chúc mọi người một ngày bình an', 'sư', 'Cầu công việc hanh thông'];
function setBots(on, n, pace){
  clearInterval(botTimer); botTimer = null;
  if (on){
    n = clamp(n, 1, 100);
    for (let i = 0; i < n; i++) seat('bot_' + i, DEMO_NAMES[(i + 7) % DEMO_NAMES.length] + ' ·bot', { demo: true });
    const every = { slow: 4000, mid: 1800, fast: 700 }[pace] || 1800;
    botTimer = setInterval(() => {
      const ids = [...viewers.keys()].filter(id => id.startsWith('bot_')); if (!ids.length) return;
      const id = ids[Math.floor(Math.random() * ids.length)], v = viewers.get(id), r = Math.random();
      if (r < .62) onChat(id, v.name, BOT_LINES[Math.floor(Math.random() * BOT_LINES.length)]);
      else if (r < .9) broadcast({ t:'like', id, n: 1 + Math.floor(Math.random() * 4) });
      else if (r < .985) onGift(id, v.name, 'Hoa hồng', 1 + Math.floor(Math.random() * 3), 1);
      else onGift(id, v.name, 'Đèn hoa sen', 1, 99);
    }, every);
    addLog(`🤖 Bật ${n} bot, nhịp ${pace}`);
  } else {
    for (const id of [...viewers.keys()]) if (id.startsWith('bot_')) { viewers.delete(id); broadcast({ t:'leave', id }); }
    addLog('🤖 Tắt bot');
  }
  broadcast({ t:'bots', on }, 'control');
}

/* -------------------------------------------------------------- server */
// Security notes (this file is meant to be shared publicly):
//  • listens on 127.0.0.1 only; nothing is reachable from the LAN or internet unless HOST is changed on purpose
//  • Host header must be localhost/127.0.0.1 (blocks DNS-rebinding pages from talking to the server)
//  • WebSocket only accepts pages served by this server (Origin check), so other sites open in the
//    same browser cannot send control commands
//  • static files: only /assets and /live, no dot-files, no node_modules, no server source, no path escapes
//  • no TikTok password, cookie or session is ever used or stored; only public room events are read
const HOST = process.env.HOST || '127.0.0.1';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
// localtest.me is public DNS that always resolves to 127.0.0.1; TikTok LIVE Studio's Link source rejects localhost/IP URLs
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`, `localtest.me:${PORT}`]);
const okHost = h => ALLOWED_HOSTS.has(String(h || '').toLowerCase());
// Cloudflare quick tunnel (cloudflared tunnel --url http://localhost:3000) for LIVE Studio's Link source:
// the public host only gets the read-only overlay (page, assets, voice files, overlay socket), never the control panel
const isTunnelHost = h => /^[a-z0-9-]+\.trycloudflare\.com$/.test(String(h || '').toLowerCase());
const isOverlayPath = p => p === '/live/overlay.html' || p.startsWith('/assets/') || p.startsWith('/live/tts/');
const SEP = path.sep;
function resolveStatic(urlPath){
  let p = urlPath === '/' ? '/live/control.html' : urlPath;
  if (!/^\/(assets|live)\//.test(p)) return null;
  if (p.split('/').some(seg => seg.startsWith('.') || seg === 'node_modules')) return null;
  if (/\.(mjs|json|md|log)$/i.test(p) && !p.startsWith('/assets/')) return null;      // never serve server code / package files
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + SEP)) return null;
  return file;
}
const server = http.createServer((req, res) => {
  const tunnel = isTunnelHost(req.headers.host);
  if (!okHost(req.headers.host) && !tunnel) { res.writeHead(421).end('wrong host'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  let p; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (tunnel && !isOverlayPath(p)) { res.writeHead(404).end('not found'); return; }
  const file = resolveStatic(p);
  if (!file) { res.writeHead(404).end('not found'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': p.startsWith('/live/tts/') ? 'no-store' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024,
  verifyClient: ({ origin, req }) => {
    if (isTunnelHost(req.headers.host)) {                       // public tunnel: overlay sockets only, from the tunnel page itself
      if (new URL(req.url, 'http://x').searchParams.get('role') === 'control') return false;
      try { return !origin || new URL(origin).host === String(req.headers.host).toLowerCase(); } catch { return false; }
    }
    if (!okHost(req.headers.host)) return false;
    if (!origin) return true;                                   // OBS / non-browser clients send no Origin
    try { return okHost(new URL(origin).host); } catch { return false; }
  } });
function broadcast(msg, only){ const s = JSON.stringify(msg); for (const c of wss.clients) if (c.readyState === 1 && (!only || c.role === only)) c.send(s); }
wss.on('connection', (ws, req) => {
  ws.role = new URL(req.url, 'http://x').searchParams.get('role') === 'control' ? 'control' : 'overlay';
  ws.send(JSON.stringify(snapshot()));
  if (ws.role === 'control') { ws.send(JSON.stringify({ t:'logs', lines: log })); ws.send(JSON.stringify(ttsProxy.status())); }
  ws.on('message', buf => {
    if (ws.role !== 'control') return;                          // overlays only listen
    try { const m = JSON.parse(buf); if (m && m.t === 'ctl') onControl(m); } catch (e) { addLog('Lệnh lỗi: ' + e.message); }
  });
});
server.listen(PORT, HOST, () => addLog(`Server chạy tại http://localhost:${PORT}  ·  Bảng điều khiển: http://localhost:${PORT}/live/control.html  ·  Overlay: http://localhost:${PORT}/live/overlay.html`));
// localhost / localtest.me also resolve to ::1, and some embedded browsers (TikTok LIVE Studio) don't fall back to IPv4:
// forward IPv6 loopback to the IPv4 listener (still loopback-only, nothing reachable from the LAN)
if (HOST === '127.0.0.1') net.createServer(c => {
  const u = net.connect(PORT, '127.0.0.1'); c.pipe(u).pipe(c);
  c.on('error', () => u.destroy()); u.on('error', () => c.destroy());
}).on('error', () => {}).listen(PORT, '::1');
// one bad event must not take the whole LIVE down: log it and keep serving
process.on('uncaughtException', e => addLog('Lỗi (đã bỏ qua): ' + (e?.stack || e)));
process.on('unhandledRejection', e => addLog('Lỗi (đã bỏ qua): ' + (e?.stack || e)));
