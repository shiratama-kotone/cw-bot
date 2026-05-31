// Chatwork Bot for Render (WebHook版 - 全ルーム対応)
// server.js

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { Pool } = require('pg');
const cheerio = require('cheerio');
const {
  Client, GatewayIntentBits, Events, REST, Routes,
  SlashCommandBuilder, AttachmentBuilder, PermissionFlagsBits, Partials
} = require('discord.js');

const app = express();
const port = process.env.PORT || 3000;

// ============================================================
// 環境変数（最初に全部定義）
// ============================================================
const CHATWORK_API_TOKEN              = process.env.CHATWORK_API_TOKEN || '';
const INFO_API_TOKEN                  = process.env.INFO_API_TOKEN || '';
const DIRECT_CHAT_WITH_DATE_CHANGE    = (process.env.DIRECT_CHAT_WITH_DATE_CHANGE || '405497983,407676893,415060980,406897783,391699365').split(',');
const LOG_ROOM_ID                     = '415060980';
const LOG_DESTINATION_ROOM_ID         = '420890621';
const DAY_JSON_URL                    = process.env.DAY_JSON_URL || 'https://raw.githubusercontent.com/shiratama-kotone/cw-bot/main/day.json';
const YUYUYU_ACCOUNT_ID               = '10544705';
const BOT_ACCOUNT_ID                  = '10386947';
const BOT_NORMAL_NAME                 = process.env.BOT_NAME || '白玉 湊音';
const BOT_NORMAL_ORG                  = process.env.BOT_ORG  || '';
const DISCORD_BOT_TOKEN               = process.env.DISCORD_BOT_TOKEN || '';
const DISCORD_WEBHOOK_URL             = process.env.DISCORD_WEBHOOK_URL || '';
// webhookURLからIDを抽出（ループ防止用）
// 例: https://discord.com/api/webhooks/1234567890/xxxx → '1234567890'
const DISCORD_WEBHOOK_ID = (() => {
  const m = DISCORD_WEBHOOK_URL.match(/\/webhooks\/(\d+)\//);
  return m ? m[1] : '';
})();
const DISCORD_BOT_USER_ID = '1491344529448501248'; // botのDiscordユーザーID
const DISCORD_BRIDGE_CW_ROOM_ID       = '415060980';
const DISCORD_BRIDGE_CHANNEL_ID       = '1371130293888745554';
const DISCORD_DATE_CHANGE_CHANNEL_ID  = '1501947796742344704';
const CW_ROOM_ID_FOR_DISCORD          = '415060980'; // Discordコマンドが対象とするCWルーム

const WEATHER_AREAS = [
  { name: 'さぽろー', code: '016010' },
  { name: 'おさかー', code: '270000' },
  { name: 'なごやー', code: '230010' },
  { name: 'ふくおかー', code: '400010' },
  { name: 'なはー',   code: '471010' }
];

// ============================================================
// PostgreSQL/Supabase接続
// ============================================================
const RAW_DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '';
let pool = null;
let dbAvailable = false;
// Chatwork名前変更のキューイング（DB回復時に1回だけ呼ぶ）
let pendingCwNameRestore = false;

function buildConnectionString(raw) {
  if (!raw) return '';
  // Supabase 直接接続 → Transaction mode pooler に変換
  // パスワードに @ が含まれても対応できるよう末尾から切り出す
  const supabaseRe = /^postgresql:\/\/([^:]+):(.+)@db\.([^.]+)\.supabase\.co:5432\/postgres$/;
  const m = raw.match(supabaseRe);
  if (m) {
    const [, user, pass, ref] = m;
    const poolUser = user.startsWith('postgres.') ? user : `postgres.${ref}`;
    const cs = `postgresql://${poolUser}:${encodeURIComponent(decodeURIComponent(pass))}@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true`;
    console.log('[DB] Supabase pooler URLに変換:', cs.replace(/:[^@]+@/, ':***@'));
    return cs;
  }
  return raw;
}

function createPool() {
  const cs = buildConnectionString(RAW_DB_URL);
  if (!cs) return null;
  return new Pool({
    connectionString: cs,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    max: 5,
  });
}

pool = createPool();

// DB回復通知（名前変更）を非同期で実行（dbQueryの外で）
async function onDbRecovered() {
  dbAvailable = true;
  console.log('[DB] 接続が回復したよ');
  try {
    const params = new URLSearchParams();
    params.append('name', BOT_NORMAL_NAME);
    if (BOT_NORMAL_ORG) params.append('organization_name', BOT_NORMAL_ORG);
    await axios.put('https://api.chatwork.com/v2/me', params, {
      headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
    });
    console.log(`[CW] 名前を ${BOT_NORMAL_NAME} に戻したよ`);
  } catch (e) { console.error('[CW] 名前変更失敗:', e.message); }
}

async function onDbFailed() {
  dbAvailable = false;
  console.error('[DB] 接続エラーが発生したよ');
  try {
    const params = new URLSearchParams();
    params.append('name', '白玉 湊音(DB接続失敗)');
    params.append('organization_name', '');
    await axios.put('https://api.chatwork.com/v2/me', params, {
      headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
    });
    console.log('[CW] 名前を DB接続失敗 に変更したよ');
  } catch (e) { console.error('[CW] 名前変更失敗:', e.message); }
}

async function dbQuery(text, params = []) {
  if (!pool) return { rows: [], rowCount: 0 };
  try {
    const result = await pool.query(text, params);
    if (!dbAvailable) {
      // 非同期で名前変更（awaitしない＝dbQueryをブロックしない）
      onDbRecovered().catch(() => {});
    }
    dbAvailable = true;
    return result;
  } catch (e) {
    const wasAvailable = dbAvailable;
    dbAvailable = false;
    if (wasAvailable) {
      onDbFailed().catch(() => {});
    }
    console.error('[DB] クエリエラー:', e.message);
    return { rows: [], rowCount: 0 };
  }
}

async function checkDbConnection() {
  if (!pool) { console.error('[DB] poolが未作成（URL未設定？）'); return false; }
  try {
    await pool.query('SELECT 1');
    dbAvailable = true;
    return true;
  } catch (e) {
    dbAvailable = false;
    console.error('[DB] 接続確認失敗:', e.message);
    return false;
  }
}

// ============================================================
// DB初期化
// ============================================================
async function initializeDatabase() {
  if (!pool) return;
  if (!await checkDbConnection()) { console.warn('[DB] 接続失敗 → テーブル初期化スキップ'); return; }
  try {
    await dbQuery(`CREATE TABLE IF NOT EXISTS webhooks (
      id SERIAL PRIMARY KEY, room_id BIGINT NOT NULL, message_id BIGINT NOT NULL,
      account_id BIGINT NOT NULL, account_name TEXT, body TEXT, send_time BIGINT NOT NULL,
      update_time BIGINT, webhook_event_type TEXT, webhook_event_time BIGINT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(message_id))`);
    await dbQuery(`CREATE INDEX IF NOT EXISTS idx_webhooks_room_send ON webhooks(room_id, send_time)`);

    await dbQuery(`CREATE TABLE IF NOT EXISTS message_logs (
      id SERIAL PRIMARY KEY, room_id BIGINT NOT NULL, account_id BIGINT NOT NULL,
      message_body TEXT, send_time BIGINT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await dbQuery(`CREATE INDEX IF NOT EXISTS idx_message_logs_created ON message_logs(created_at)`);

    await dbQuery(`CREATE TABLE IF NOT EXISTS jirai_toggles (
      id SERIAL PRIMARY KEY, toggle_name VARCHAR(50) UNIQUE NOT NULL,
      is_enabled BOOLEAN DEFAULT FALSE, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    for (const t of ['gakusei','nyanko_a','milk','admin','yuyuyu'])
      await dbQuery(`INSERT INTO jirai_toggles (toggle_name,is_enabled) VALUES ($1,false) ON CONFLICT DO NOTHING`, [t]);

    await dbQuery(`CREATE TABLE IF NOT EXISTS alarms (
      id SERIAL PRIMARY KEY, room_id BIGINT, discord_channel_id TEXT,
      scheduled_time TIMESTAMP NOT NULL, message TEXT NOT NULL,
      created_by BIGINT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await dbQuery(`ALTER TABLE alarms ADD COLUMN IF NOT EXISTS discord_channel_id TEXT`);

    await dbQuery(`CREATE TABLE IF NOT EXISTS total_message_counts (
      id SERIAL PRIMARY KEY, room_id BIGINT NOT NULL, account_id BIGINT NOT NULL,
      message_count BIGINT DEFAULT 0, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(room_id, account_id))`);

    await dbQuery(`CREATE TABLE IF NOT EXISTS black_list (
      id SERIAL PRIMARY KEY, room_id BIGINT NOT NULL, account_id BIGINT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(room_id, account_id))`);
    await dbQuery(`CREATE INDEX IF NOT EXISTS idx_bl ON black_list(room_id, account_id)`);

    await dbQuery(`CREATE TABLE IF NOT EXISTS points (
      id SERIAL PRIMARY KEY, room_id BIGINT NOT NULL, account_id BIGINT NOT NULL,
      point BIGINT DEFAULT 0, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(room_id, account_id))`);

    await dbQuery(`CREATE TABLE IF NOT EXISTS fever (
      id SERIAL PRIMARY KEY, room_id BIGINT NOT NULL UNIQUE, ends_at TIMESTAMP NOT NULL)`);

    await dbQuery(`CREATE TABLE IF NOT EXISTS discord_prohibit (
      id SERIAL PRIMARY KEY, channel_id TEXT NOT NULL UNIQUE, ends_at TIMESTAMP NOT NULL)`);

    await dbQuery(`CREATE TABLE IF NOT EXISTS ng_words (
      id SERIAL PRIMARY KEY, room_id BIGINT NOT NULL, word TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(room_id, word))`);

    await dbQuery(`CREATE TABLE IF NOT EXISTS discord_bridge (
      id SERIAL PRIMARY KEY, cw_message_id TEXT, discord_message_id TEXT,
      cw_account_id TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await dbQuery(`ALTER TABLE discord_bridge ADD COLUMN IF NOT EXISTS cw_account_id TEXT`);

    console.log('[DB] テーブル初期化完了');
  } catch (e) { console.error('[DB] 初期化エラー:', e.message); }
}

// ============================================================
// 地雷トグル
// ============================================================
async function loadJiraiToggles() {
  const r = await dbQuery('SELECT toggle_name, is_enabled FROM jirai_toggles');
  const t = {};
  r.rows.forEach(row => { t[row.toggle_name] = row.is_enabled; });
  return t;
}
async function saveJiraiToggle(name, val) {
  await dbQuery('UPDATE jirai_toggles SET is_enabled=$1, updated_at=NOW() WHERE toggle_name=$2', [val, name]);
}

// ============================================================
// メモリストレージ
// ============================================================
const mem = {
  lastSentDates: new Map(),
  messageCounts: new Map(),
  roomResetDates: new Map(),
  lastEarthquakeId: null,
  lastNhkNewsId: null,
  sentWarnings: new Map(),
};

// ============================================================
// Chatwork APIレートリミット
// ============================================================
let apiCallTs = [];
async function apiCallLimiter() {
  const now = Date.now();
  apiCallTs = apiCallTs.filter(t => now - t < 10000);
  if (apiCallTs.length >= 10) {
    await new Promise(r => setTimeout(r, 10000 - (now - apiCallTs[0]) + 50));
  }
  apiCallTs.push(Date.now());
}

// ============================================================
// Chatwork絵文字カウント
// ============================================================
const CW_EMOJI_NO_P  = [':)',':(',':D','8-)',':o',';)',';(',':|',':*',':p',':^)','|-)',']:)','8-|',':#)',':/' ];
const CW_EMOJI_W_P   = ['sweat','blush','inlove','talk','yawn','puke','emo','nod','shake','^^;','whew','clap','bow','roger','flex','dance','gogo','think','please','quick','anger','devil','lightbulb','*','h','F','cracker','eat','^','coffee','beer','handshake','y','ec14'];
const esc = s => s.replace(/[-\/\\^$*+?.()|[\]{}]/g,'\\$&');
const EMOJI_RE = new RegExp(`(?:${CW_EMOJI_NO_P.map(esc).join('|')})|\\((${CW_EMOJI_W_P.map(esc).join('|')})\\)`,'g');
function countEmojis(text) {
  const clean = text.replace(/https?:\/\/[^\s\]）)]+/g,'').replace(/\[info\][\s\S]*?\[\/info\]/g,'').replace(/\[[^\]]+\]/g,'');
  return (clean.match(EMOJI_RE)||[]).length;
}

// APIキャッシュ
const API_CACHE = new Map();
function addToCache(k,v) { if(API_CACHE.size>=50) API_CACHE.delete(API_CACHE.keys().next().value); API_CACHE.set(k,v); }

// ============================================================
// day.json
// ============================================================
async function loadDayEvents() {
  try { return (await axios.get(DAY_JSON_URL)).data; } catch { return {}; }
}
async function getTodaysEvents() {
  try {
    const data = await loadDayEvents();
    const jst  = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));
    const key  = `${String(jst.getMonth()+1).padStart(2,'0')}-${String(jst.getDate()).padStart(2,'0')}`;
    const ev   = data[key] || [];
    return Array.isArray(ev) ? ev : [ev];
  } catch { return []; }
}

// ============================================================
// Chatwork ユーティリティ
// ============================================================
const CW = {
  async members(roomId) {
    await apiCallLimiter();
    try {
      return (await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}/members`,
        {headers:{'X-ChatWorkToken':CHATWORK_API_TOKEN}})).data
        .map(m=>({account_id:m.account_id,name:m.name,role:m.role}));
    } catch { return []; }
  },
  async roomInfo(roomId) {
    await apiCallLimiter();
    try {
      return (await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}`,
        {headers:{'X-ChatWorkToken':CHATWORK_API_TOKEN}})).data;
    } catch { return null; }
  },
  async send(roomId, msg) {
    await apiCallLimiter();
    try {
      return (await axios.post(`https://api.chatwork.com/v2/rooms/${roomId}/messages`,
        new URLSearchParams({body:msg}),
        {headers:{'X-ChatWorkToken':CHATWORK_API_TOKEN}})).data.message_id;
    } catch (e) { console.error(`[CW] 送信エラー(${roomId}):`,e.message); return null; }
  },
  async getMessage(roomId, msgId) {
    await apiCallLimiter();
    try {
      return (await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}/messages/${msgId}`,
        {headers:{'X-ChatWorkToken':CHATWORK_API_TOKEN}})).data;
    } catch { return null; }
  },
  async deleteMessage(roomId, msgId) {
    await apiCallLimiter();
    try {
      await axios.delete(`https://api.chatwork.com/v2/rooms/${roomId}/messages/${msgId}`,
        {headers:{'X-ChatWorkToken':CHATWORK_API_TOKEN}});
      return true;
    } catch { return false; }
  },
  async isMember(roomId) {
    await apiCallLimiter();
    try {
      await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}`,{headers:{'X-ChatWorkToken':CHATWORK_API_TOKEN}});
      return true;
    } catch { return false; }
  },
  async getRoomMessages(roomId) {
    await apiCallLimiter();
    try {
      return (await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}/messages`,
        {headers:{'X-ChatWorkToken':CHATWORK_API_TOKEN},params:{force:1}})).data||[];
    } catch { return []; }
  },
  async roomInfoWithToken(roomId, token) {
    await apiCallLimiter();
    try {
      return (await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}`,{headers:{'X-ChatWorkToken':token}})).data;
    } catch (e) { return e.response?.status===404?{error:'not_found'}:{error:'unknown'}; }
  },
  async membersWithToken(roomId, token) {
    await apiCallLimiter();
    try {
      return (await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}/members`,{headers:{'X-ChatWorkToken':token}})).data
        .map(m=>({account_id:m.account_id,name:m.name,role:m.role}));
    } catch { return []; }
  },
  isAdmin(accountId, members) {
    const u = members.find(m=>m.account_id===accountId);
    return u?.role==='admin';
  },
  async nameById(targetId, cached=[], roomId=null) {
    const f = cached.find(m=>String(m.account_id)===String(targetId));
    if(f) return f.name;
    if(roomId) {
      const ms = await CW.members(roomId);
      const m = ms.find(m=>String(m.account_id)===String(targetId));
      if(m) return m.name;
    }
    try {
      await apiCallLimiter();
      const res = await axios.get('https://api.chatwork.com/v2/contacts',{headers:{'X-ChatWorkToken':CHATWORK_API_TOKEN}});
      const c = res.data.find(c=>String(c.account_id)===String(targetId));
      if(c) return c.name;
    } catch {}
    return String(targetId);
  },
  async addBlackList(roomId, accountId) {
    await dbQuery('INSERT INTO black_list (room_id,account_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[roomId,accountId]);
  },
  async isBlackListed(roomId, accountId) {
    const r = await dbQuery('SELECT 1 FROM black_list WHERE room_id=$1 AND account_id=$2',[roomId,accountId]);
    return r.rowCount>0;
  },
  async forceReadOnly(roomId, targetId, members) {
    try {
      const admins  = members.filter(m=>m.role==='admin').map(m=>String(m.account_id));
      const mems    = members.filter(m=>m.role==='member'&&String(m.account_id)!==String(targetId)).map(m=>String(m.account_id));
      const ro      = members.filter(m=>m.role==='readonly').map(m=>String(m.account_id));
      if(!ro.includes(String(targetId))) ro.push(String(targetId));
      const p = new URLSearchParams();
      if(admins.length) p.append('members_admin_ids',admins.join(','));
      if(mems.length)   p.append('members_member_ids',mems.join(','));
      if(ro.length)     p.append('members_readonly_ids',ro.join(','));
      await apiCallLimiter();
      await axios.put(`https://api.chatwork.com/v2/rooms/${roomId}/members`,p,{headers:{'X-ChatWorkToken':CHATWORK_API_TOKEN}});
      return true;
    } catch { return false; }
  },
  async sendLog(userName, body, sourceRoomId) {
    if(sourceRoomId!==LOG_ROOM_ID) return;
    await CW.send(LOG_DESTINATION_ROOM_ID,`[info][title]${userName}[/title]${body}[/info]`).catch(()=>{});
  },
  drawOmikuji() {
    // 通常版（大凶が圧倒的に多い）
    if(Math.random()<0.002) return '湊音すぺしゃるっ！';
    const f=[{n:'大吉',w:0.01},{n:'中吉',w:0.02},{n:'吉',w:0.02},{n:'小吉',w:0.2},{n:'末吉',w:0.2},{n:'凶',w:0.5},{n:'大凶',w:99.05}];
    let r=Math.random()*f.reduce((s,x)=>s+x.w,0);
    for(const x of f){ if(r<x.w) return x.n; r-=x.w; }
    return '凶';
  },
  drawNormalOmikuji() {
    // 普通のおみくじ（均等に近い確率、大凶が極端に多くない）
    const f=[{n:'大吉',w:10},{n:'中吉',w:15},{n:'吉',w:20},{n:'小吉',w:20},{n:'末吉',w:15},{n:'凶',w:12},{n:'大凶',w:8}];
    let r=Math.random()*f.reduce((s,x)=>s+x.w,0);
    for(const x of f){ if(r<x.w) return x.n; r-=x.w; }
    return '吉';
  },
  summarizeOmikuji(results) {
    // 複数おみくじ結果を「大凶：XX、凶：XX...」形式にまとめる
    const count={};
    for(const r of results) count[r]=(count[r]||0)+1;
    const order=['湊音すぺしゃるっ！','大吉','中吉','吉','小吉','末吉','凶','大凶'];
    return order.filter(k=>count[k]).map(k=>`${k}：${count[k]}`).join('、');
  },
  async yesOrNo() {
    try { return (await axios.get('https://yesno.wtf/api')).data.answer||'no'; } catch { return Math.random()<0.5?'yes':'no'; }
  },
  async wikipedia(term) {
    const key=`wiki_${term}`, now=Date.now();
    if(API_CACHE.has(key)){ const c=API_CACHE.get(key); if(now-c.ts<300000) return c.d; }
    try {
      const sr = await axios.get(`https://ja.wikipedia.org/w/api.php?${new URLSearchParams({action:'opensearch',format:'json',search:term,limit:1,namespace:0,redirects:'resolve'})}`,{timeout:10000,headers:{'User-Agent':'ChatworkBot/1.0'}});
      if(!sr.data?.[1]?.length){ const r=`「${term}」に関する記事は見つからなかったよ`; addToCache(key,{d:r,ts:now}); return r; }
      const title=sr.data[1][0], url=sr.data[3][0];
      const er = await axios.get(`https://ja.wikipedia.org/w/api.php?${new URLSearchParams({action:'query',format:'json',prop:'extracts',exintro:true,explaintext:true,titles:title,redirects:1})}`,{timeout:10000,headers:{'User-Agent':'ChatworkBot/1.0'}});
      const pages=er.data?.query?.pages;
      if(pages){ const pid=Object.keys(pages)[0]; if(pid&&pid!=='-1'&&pages[pid]?.extract){ let s=pages[pid].extract; if(s.length>500) s=s.substring(0,500)+'...'; const r=`${s}\n\n元記事は ${url} だよっ！`; addToCache(key,{d:r,ts:now}); return r; } }
      const r=`「${term}」の情報を取得できなかったよ`; addToCache(key,{d:r,ts:now}); return r;
    } catch(e){ return `Wikipedia検索中にエラー: ${e.message}`; }
  },
  async scratchUser(username) {
    try {
      const d=(await axios.get(`https://api.scratch.mit.edu/users/${encodeURIComponent(username)}`)).data;
      const bio=d.profile?.bio||'', st=d.profile?.status||'';
      let r='';
      if(bio) r+=`[info][title]私について[/title]${bio}[/info]\n\n`;
      if(st)  r+=`[info][title]私が取り組んでいること[/title]${st}[/info]\n\n`;
      if(!bio&&!st) r=`[info][title]Scratchユーザー情報[/title]プロフィール情報がないよっ！[/info]\n\n`;
      return r+`ユーザーページ: https://scratch.mit.edu/users/${encodeURIComponent(username)}/`;
    } catch(e){ return e.response?.status===404?`「${username}」というScratchユーザーは見つからなかったよ`:`エラーが起きちゃった`; }
  },
  async scratchProject(id) {
    try {
      const d=(await axios.get(`https://api.scratch.mit.edu/projects/${id}`)).data;
      if(!d?.title) return 'プロジェクトが見つからなかったよ';
      return `[info][title]Scratchプロジェクト情報[/title]タイトル: ${d.title}\n作者: ${d.author.username}\n説明: ${d.description||'説明なし'}\nURL: https://scratch.mit.edu/projects/${id}/[/info]`;
    } catch { return 'Scratchプロジェクト情報の取得中にエラーが発生したよ'; }
  },
  async lyrics(url) {
    try {
      const res = await axios.get(url,{timeout:15000,headers:{'User-Agent':'Mozilla/5.0','Accept':'text/html','Accept-Language':'ja'}});
      const $   = cheerio.load(res.data);
      let title='', lyr='';
      if(url.includes('utaten.com')) {
        title=$('h2.newLyricTitle__main').text().trim()||$('title').text().split('の歌詞')[0].trim();
        $('span.rt,rp,rt').remove();
        lyr=($('div.hiragana').first().html()||'').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'').trim();
      } else if(url.includes('uta-net.com')) {
        title=$('h2.ms-2').text().trim()||$('h1').first().text().trim();
        lyr=($('div#kashi_area').first().html()||'').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'').trim();
      } else if(url.includes('atwiki.jp')) {
        const h3=$('h3:contains("曲紹介")');
        if(h3.length){ let c=h3.next(); while(c.length&&!c.is('h3')){ const mx=c.text().match(/曲名：[『「]?(.+?)[』」]?[（(]/); if(mx){title=mx[1].trim();break;} c=c.next(); } }
        if(!title){ title=$('title').text().trim(); if(title.includes(' - ')) title=title.split(' - ')[0].trim(); }
        const ls=$('h3:contains("歌詞")');
        if(!ls.length) return '歌詞セクションが見つからなかったよ';
        let lh='', c2=ls.next();
        while(c2.length){ if(c2.is('h3')&&c2.text().includes('関連動画')) break; if(c2.is('div')||c2.is('br')) lh+=$.html(c2); c2=c2.next(); }
        lyr=lh.replace(/<br\s*\/?>/gi,'\n').replace(/<div>/gi,'').replace(/<\/div>/gi,'\n').replace(/<[^>]+>/g,'').replace(/\n{3,}/g,'\n\n').trim();
      } else {
        return '対応していないURLだよっ！utaten.com、uta-net.com、またはatwiki.jpのURLを指定してねっ！';
      }
      if(!lyr) return '歌詞の取得に失敗しちゃった。URLを確認してくれるとうれしいな';
      if(lyr.length>3500) lyr=lyr.substring(0,3500)+'\n…（以下省略）';
      return `[info][title]${title||'不明'}の歌詞だよっ！[/title]${lyr}[/info]`;
    } catch(e){ return `歌詞の取得中にエラー: ${e.message}`; }
  },
  async weather(code) {
    try { return (await axios.get(`https://weather.tsukumijima.net/api/forecast/city/${code}`,{timeout:10000})).data; } catch { return null; }
  },
  async getJiraiProb(accountId, isAdmin) {
    let p=0.0005;
    const t=await loadJiraiToggles();
    const id=String(accountId);
    if(t.gakusei&&id==='9553691')  p=Math.max(p,0.25);
    if(t.nyanko_a&&id==='9487124') p=Math.max(p,1.0);
    if(t.milk&&id==='11092754')    p=Math.max(p,0.50);
    if(t.admin&&isAdmin)           p=Math.max(p,0.25);
    if(t.yuyuyu&&id==='10911090')  p=Math.max(p,0.75);
    return p;
  },
};

// ============================================================
// ランキングヘルパー
// ============================================================
function getTodayStartTs() {
  const jst=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));
  return Math.floor(new Date(jst.getFullYear(),jst.getMonth(),jst.getDate()).getTime()/1000);
}
async function getTodayCounts(roomId) {
  const r=await dbQuery(`SELECT account_id,COUNT(*) as count FROM webhooks WHERE room_id=$1 AND webhook_event_type='message_created' AND send_time>=$2 GROUP BY account_id ORDER BY count DESC`,[roomId,getTodayStartTs()]);
  return {rows:r.rows.map(x=>({accountId:String(x.account_id),count:parseInt(x.count)}))};
}
async function buildRankingMsg(title, data, members, roomId=null) {
  const rows=(data?.rows||[]);
  const total=rows.reduce((s,r)=>s+r.count,0);
  let msg=`[info][title]${title}[/title]\n`;
  if(!rows.length) msg+='今日のメッセージはまだないみたい。\n';
  else for(let i=0;i<rows.length;i++){
    const name=await CW.nameById(rows[i].accountId,members,roomId);
    msg+=`${i+1}位：${name} ${rows[i].count}コメ`;
    if(i<rows.length-1) msg+='\n[hr]';
    msg+='\n';
  }
  msg+=`\n合計：${total}コメ\n(ぼく込み)[/info]`;
  return msg;
}

// ============================================================
// WebHookメッセージ処理
// ============================================================
async function processWebHook(data) {
  try {
    // DB保存
    await dbQuery(`INSERT INTO webhooks (room_id,message_id,account_id,account_name,body,send_time,update_time,webhook_event_type,webhook_event_time)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (message_id) DO NOTHING`,
      [data.room_id,data.message_id,data.account_id,data.account?.name||null,data.body||'',
       data.send_time,data.update_time||null,data.webhook_event_type||'message_created',data.webhook_event_time||null]);

    // ログ保存
    if(String(data.room_id)===LOG_ROOM_ID&&(data.webhook_event_type||'message_created')==='message_created')
      await dbQuery('INSERT INTO message_logs (room_id,account_id,message_body,send_time) VALUES ($1,$2,$3,$4)',
        [data.room_id,data.account_id,data.body||'',data.send_time]).catch(()=>{});

    const {room_id:roomId, body:messageBody, message_id:messageId, account_id:accountId, account} = data;
    const eventType = data.webhook_event_type||'message_created';

    if(String(accountId)===BOT_ACCOUNT_ID) {
      // botのメッセージもDiscord転送対象にするが、コマンド処理等はスキップ
      if(String(roomId)===DISCORD_BRIDGE_CW_ROOM_ID && eventType==='message_created' && DISCORD_WEBHOOK_URL){
        const botName = account?.name || BOT_NORMAL_NAME;
        const txt = cwToDiscordText(messageBody);
        if(txt){
          const did = await sendToDiscord(`${botName}：${txt}`);
          if(did){
            discordWebhookMsgIds.add(did);
            await dbQuery('INSERT INTO discord_bridge (cw_message_id,discord_message_id,cw_account_id) VALUES ($1,$2,$3)',
              [String(messageId),did,String(accountId)]).catch(()=>{});
          }
        }
      }
      return;
    }
    if(!roomId||!accountId||!messageBody) return;

    // 累計発言数
    if(eventType==='message_created')
      await dbQuery(`INSERT INTO total_message_counts (room_id,account_id,message_count) VALUES ($1,$2,1)
        ON CONFLICT (room_id,account_id) DO UPDATE SET message_count=total_message_counts.message_count+1,updated_at=NOW()`,
        [roomId,accountId]).catch(()=>{});

    // NGワードチェック
    if(eventType==='message_created'){
      const ngR=await dbQuery('SELECT word FROM ng_words WHERE room_id=$1',[roomId]);
      if(ngR.rowCount>0){
        const mems=await CW.members(roomId);
        if(!CW.isAdmin(accountId,mems)){
          const hit=ngR.rows.find(r=>messageBody.includes(r.word));
          if(hit){
            await CW.addBlackList(roomId,accountId);
            await CW.forceReadOnly(roomId,accountId,mems);
            const n=await CW.nameById(accountId,mems,roomId);
            await CW.send(roomId,`[picon:${accountId}]${n}ちゃんがNGワード「${hit.word}」を含むメッセージを送ったから閲覧のみにしたよ`);
          }
        }
      }
    }

    // ポイント付与
    if(eventType==='message_created'){
      const PRIV=['10911090','9553691'];
      const mems=await CW.members(roomId).catch(()=>[]);
      let bp=1;
      if(PRIV.includes(String(accountId))) bp=5;
      else if(CW.isAdmin(accountId,mems)) bp=2;
      const fv=await dbQuery('SELECT ends_at FROM fever WHERE room_id=$1 AND ends_at>NOW()',[roomId]);
      if(fv.rowCount>0) bp*=10;
      await dbQuery(`INSERT INTO points (room_id,account_id,point) VALUES ($1,$2,$3)
        ON CONFLICT (room_id,account_id) DO UPDATE SET point=points.point+$3,updated_at=NOW()`,
        [roomId,accountId,bp]).catch(()=>{});
    }

    // ウェルカム & ブラックリスト
    if(messageBody.includes('[dtext:chatroom_member_is]')&&messageBody.includes('[dtext:chatroom_added]')){
      const m=messageBody.match(/\[piconname:(\d+)\]/);
      if(m?.[1]){
        const uid=m[1];
        if(await CW.isBlackListed(String(roomId),uid)){
          await new Promise(r=>setTimeout(r,1500));
          const fm=await CW.members(roomId);
          await CW.forceReadOnly(roomId,uid,fm);
          await CW.send(roomId,`[To:${uid}][picon:${uid}]${await CW.nameById(uid,fm)}ちゃんはブラックリストに入ってるから閲覧のみにしたよ`);
        } else if(String(roomId)===LOG_ROOM_ID){
          const fm=await CW.members(roomId);
          await new Promise(r=>setTimeout(r,1000));
          await CW.send(roomId,`[To:${uid}][picon:${uid}]${await CW.nameById(uid,fm)}ちゃん\nこの部屋へようこそ！\nこの部屋は色々とおかしいけどよろしくね！`);
        }
      }
    }

    // 権限変更ブラックリストチェック
    if(messageBody.includes('[dtext:chatroom_member_is]')&&messageBody.includes('[dtext:chatroom_priv_changed]')){
      const m=messageBody.match(/\[piconname:(\d+)\]/);
      if(m?.[1]&&await CW.isBlackListed(String(roomId),m[1])){
        await new Promise(r=>setTimeout(r,1500));
        const fm=await CW.members(roomId);
        const mem=fm.find(x=>String(x.account_id)===m[1]);
        if(mem&&mem.role!=='readonly'){
          await CW.forceReadOnly(roomId,m[1],fm);
          await CW.send(roomId,`[picon:${m[1]}]${await CW.nameById(m[1],fm)}ちゃんはブラックリストに入ってるから閲覧のみに戻したよ`);
        }
      }
    }

    // メッセージカウント
    {
      const jst=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));
      const td=jst.toISOString().split('T')[0];
      if(mem.roomResetDates.get(roomId)!==td){ mem.messageCounts.set(roomId,{}); mem.roomResetDates.set(roomId,td); }
      const rc=mem.messageCounts.get(roomId)||{};
      rc[accountId]=(rc[accountId]||0)+1;
      mem.messageCounts.set(roomId,rc);
    }

    const isDirectChat = data.room_type==='direct';
    let currentMembers=[], isSenderAdmin=true;
    if(!isDirectChat){ currentMembers=await CW.members(roomId); isSenderAdmin=CW.isAdmin(accountId,currentMembers); }

    let userName=account?.name||await CW.nameById(accountId,currentMembers);

    await CW.sendLog(userName,messageBody,roomId);

    // 転送（415060980 → 420890621 & Discord）
    if(String(roomId)===DISCORD_BRIDGE_CW_ROOM_ID){
      const editLabel=eventType==='message_updated'?'(編集)':'';
      await CW.send(LOG_DESTINATION_ROOM_ID,`[info][title]${userName}${editLabel}[/title]${messageBody}[/info]`).catch(()=>{});
      if(eventType==='message_created'&&DISCORD_WEBHOOK_URL){
        const txt=cwToDiscordText(messageBody);
        if(txt){
          const did=await sendToDiscord(`${userName}：${txt}`);
          if(did){
            discordWebhookMsgIds.add(did);
            await dbQuery('INSERT INTO discord_bridge (cw_message_id,discord_message_id,cw_account_id) VALUES ($1,$2,$3)',
              [String(messageId),did,String(accountId)]).catch(()=>{});
          }
        }
      }
    }

    // TOALL
    if(!isDirectChat&&messageBody.toLowerCase().includes('toall')&&!isSenderAdmin){
      await CW.send(roomId,'[info]TOALLを検知したよ！\nフィルターが作動するよ！[/info]');
      const p=new URLSearchParams();
      const ad=currentMembers.filter(m=>m.role==='admin').map(m=>String(m.account_id));
      const me=currentMembers.filter(m=>m.role==='member'&&String(m.account_id)!==String(accountId)).map(m=>String(m.account_id));
      const ro=[...currentMembers.filter(m=>m.role==='readonly').map(m=>String(m.account_id)),String(accountId)];
      if(ad.length) p.append('members_admin_ids',ad.join(','));
      if(me.length) p.append('members_member_ids',me.join(','));
      if(ro.length) p.append('members_readonly_ids',ro.join(','));
      await apiCallLimiter();
      await axios.put(`https://api.chatwork.com/v2/rooms/${roomId}/members`,p,{headers:{'X-ChatWorkToken':CHATWORK_API_TOKEN}}).catch(()=>{});
      await CW.addBlackList(roomId,accountId);
    }

    // 地雷（LOG_ROOM_IDのみ）
    if(String(roomId)===LOG_ROOM_ID){
      const prob=await CW.getJiraiProb(accountId,isSenderAdmin);
      if(Math.random()<prob){
        const admins=currentMembers.filter(m=>m.role==='admin');
        if(admins.length){
          const ra=admins[Math.floor(Math.random()*admins.length)];
          await CW.send(roomId,`[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\n地雷ふんじゃったね…\n[To:${ra.account_id}]${ra.name}に罰ゲームを考えてもらってね！`);
        }
      }
    }

    // 絵文字大量
    if(!isDirectChat){
      const ec=countEmojis(messageBody);
      if(ec>=50&&!isSenderAdmin){
        await CW.send(roomId,`[info]Chatworkの絵文字を${ec}個検知したよ！\nフィルターが作動するよ！[/info]`);
        const p=new URLSearchParams();
        const ad=currentMembers.filter(m=>m.role==='admin').map(m=>String(m.account_id));
        const me=currentMembers.filter(m=>m.role==='member'&&String(m.account_id)!==String(accountId)).map(m=>String(m.account_id));
        const ro=[...currentMembers.filter(m=>m.role==='readonly').map(m=>String(m.account_id)),String(accountId)];
        if(ad.length) p.append('members_admin_ids',ad.join(','));
        if(me.length) p.append('members_member_ids',me.join(','));
        if(ro.length) p.append('members_readonly_ids',ro.join(','));
        await apiCallLimiter();
        await axios.put(`https://api.chatwork.com/v2/rooms/${roomId}/members`,p,{headers:{'X-ChatWorkToken':CHATWORK_API_TOKEN}}).catch(()=>{});
        await CW.addBlackList(roomId,accountId);
      }
    }

    // ━━ Chatwork コマンド ━━
    const rp = (msg)=>CW.send(roomId,`[rp aid=${accountId} to=${roomId}-${messageId}]${msg}`);
    // コマンドをDiscordに転送するヘルパー（対象ルームのみ）
    const sendCmdToDiscord = async (cmdText, responseTxt) => {
      if(String(roomId) !== DISCORD_BRIDGE_CW_ROOM_ID) return;
      if(!DISCORD_WEBHOOK_URL) return;
      // コマンド送信
      const cmdDiscordMsg = `${userName}：${cmdText}`;
      const cmdDid = await sendToDiscord(cmdDiscordMsg);
      if(cmdDid) discordWebhookMsgIds.add(cmdDid);
      // レスポンス送信
      if(responseTxt){
        const resTxt = cwToDiscordText(responseTxt);
        if(resTxt){
          const resDid = await sendToDiscord(`${BOT_NORMAL_NAME}：${resTxt}`);
          if(resDid) discordWebhookMsgIds.add(resDid);
        }
      }
    };
    // rpをラップ：CWに送りつつDiscordにも転送
    const rpAndDiscord = async (msg) => {
      await rp(msg);
      await sendCmdToDiscord(messageBody, msg);
    };
    const adminOnly = async ()=>{ if(!isSenderAdmin){ await rpAndDiscord('管理者しか実行できないコマンドだよ！'); return false; } return true; };

    if(messageBody==='/miaq ') { await rpAndDiscord('Make it a QuoteはDiscordの /miaq コマンドで使えるよ！'); return; }
    if(messageBody.startsWith('/lyric ')){
      const url=messageBody.substring(7).trim();
      if(url&&(url.includes('utaten.com')||url.includes('uta-net.com')||url.includes('atwiki.jp')))
        await rpAndDiscord(await CW.lyrics(url));
      else await rpAndDiscord('つかいかたは /lyric {utaten.com、uta-net.com、またはatwiki.jpのURL} だよ');
      return;
    }
    if(messageBody.startsWith('/song-typing-info ')){
      const sid=messageBody.substring(18).trim();
      await rpAndDiscord(sid?await getSongTypingInfo(sid):'つかいかたは /song-typing-info {曲ID} だよ'); return;
    }
    if(['削除','delete','/del','けして'].some(k=>messageBody.includes(k))){
      const m=messageBody.match(/\[rp aid=(\d+) to=(\d+)-(\d+)\]/);
      if(m){ const tm=await CW.getMessage(roomId,m[3]); if(tm&&String(tm.account.account_id)===BOT_ACCOUNT_ID) await CW.deleteMessage(roomId,m[3]); }
    }
    if(messageBody.startsWith('/alarm ')){
      const mx=messageBody.substring(7).trim().match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s+(.+)$/);
      if(!mx){ await rpAndDiscord('使い方: /alarm YYYY-MM-DD HH:MM メッセージ内容'); return; }
      const t=new Date(`${mx[1]}T${mx[2]}:00+09:00`);
      await dbQuery('INSERT INTO alarms (room_id,scheduled_time,message,created_by) VALUES ($1,$2,$3,$4)',[roomId,t,mx[3],accountId]);
      await rpAndDiscord(`アラームを設定したよ！\n${t.toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})} に「${mx[3]}」を送信するね`); return;
    }
    if(messageBody==='/message-total'){
      const r=await dbQuery('SELECT account_id,message_count FROM total_message_counts WHERE room_id=$1 ORDER BY message_count DESC',[roomId]);
      if(!r.rows.length){ await rpAndDiscord('この部屋の累計発言数はまだないみたい'); return; }
      let msg='[info][title]累計発言数ランキング[/title]\n';
      for(let i=0;i<r.rows.length;i++){
        const n=await CW.nameById(r.rows[i].account_id,currentMembers,roomId);
        msg+=`${i+1}位：${n} ${r.rows[i].message_count}コメ`;
        if(i<r.rows.length-1) msg+='\n[hr]'; msg+='\n';
      }
      msg+=`\n合計：${r.rows.reduce((s,x)=>s+parseInt(x.message_count),0)}コメ[/info]`;
      await rpAndDiscord(msg); return;
    }
    if(messageBody==='おみくじ'){ await rpAndDiscord(`${userName}ちゃん[info][title]おみくじ[/title]おみくじの結果は…\n\n${CW.drawOmikuji()}\n\nだよっ！[/info]`); }
    // おみくじXX連（大凶99%版）
    {
      const m10=messageBody.match(/^おみくじ(\d+)連$/);
      if(m10){
        const n=Math.min(parseInt(m10[1]),10000);
        if(n>=1){
          const rs=Array.from({length:n},()=>CW.drawOmikuji());
          await rpAndDiscord(`${userName}ちゃん[info][title]おみくじ${n}連[/title]おみくじ${n}連の結果は…\n\n${CW.summarizeOmikuji(rs)}\n\nだよっ！[/info]`);
        }
      }
    }
    if(messageBody==='/normal-omikuji'){ await rpAndDiscord(`${userName}ちゃん[info][title]普通のおみくじ[/title]おみくじの結果は…\n\n${CW.drawNormalOmikuji()}\n\nだよっ！[/info]`); }
    // /normal-omikuji-XX（普通のおみくじXX連）
    {
      const mn=messageBody.match(/^\/normal-omikuji-(\d+)$/);
      if(mn){
        const n=Math.min(parseInt(mn[1]),10000);
        if(n>=1){
          const rs=Array.from({length:n},()=>CW.drawNormalOmikuji());
          await rpAndDiscord(`${userName}ちゃん[info][title]普通のおみくじ${n}連[/title]普通のおみくじ${n}連の結果は…\n\n${CW.summarizeOmikuji(rs)}\n\nだよっ！[/info]`);
        }
      }
    }
    if(messageBody==='/yes-or-no'){ await rpAndDiscord(`${userName}ちゃん\n答えは「${await CW.yesOrNo()}」だよっ！`); }
    if(messageBody.startsWith('/wiki ')){ const t=messageBody.substring(6).trim(); await rpAndDiscord(t?`${userName}ちゃん\nWikipediaの検索結果だよっ！\n\n${await CW.wikipedia(t)}`:'つかいかたは /wiki 検索ワード だよ'); return; }
    if(messageBody.startsWith('/info ')&&INFO_API_TOKEN){
      const tid=messageBody.substring(6).trim();
      if(!(isDirectChat||isSenderAdmin)){ await rpAndDiscord('このコマンドは管理者だけが使えるよ'); return; }
      const ri=await CW.roomInfoWithToken(tid,INFO_API_TOKEN);
      if(ri.error){ await rpAndDiscord(ri.error==='not_found'?'存在しないルームかも。':'ルーム情報持ってくるのに失敗しちゃった。'); return; }
      const ms=await CW.membersWithToken(tid,INFO_API_TOKEN);
      if(!ms.some(m=>String(m.account_id)===YUYUYU_ACCOUNT_ID)){ await rpAndDiscord('ますたーが参加してないかも。'); return; }
      const ip=ri.icon_path||''; const il=ip?(ip.startsWith('http')?ip:`https://appdata.chatwork.com${ip}`):'なし';
      await rpAndDiscord(`${userName}ちゃん\n[info][title]${ri.name}の情報だよっ！[/title]部屋名：${ri.name}\nメンバー数：${ms.length}人\n管理者数：${ms.filter(m=>m.role==='admin').length}人\nルームID：${tid}\nファイル数：${ri.file_num||0}\nメッセージ数：${ri.message_num||0}\nアイコン：${il}\n管理者一覧：${ms.filter(m=>m.role==='admin').map(m=>m.name).join(', ')||'なし'}[/info]`); return;
    }
    if(messageBody.startsWith('/scratch-user ')){ const u=messageBody.substring(14).trim(); await rpAndDiscord(u?`${userName}ちゃん\n${await CW.scratchUser(u)}`:'つかいかたは /scratch-user ユーザー名 だよ'); return; }
    if(messageBody.startsWith('/scratch-project ')){ const id=messageBody.substring(17).trim(); await rpAndDiscord(id?`${userName}ちゃん\n${await CW.scratchProject(id)}`:'つかいかたは /scratch-project プロジェクトID だよ'); return; }
    if(messageBody==='/blacklist'){
      if(!await adminOnly()) return;
      const r=await dbQuery('SELECT account_id FROM black_list WHERE room_id=$1 ORDER BY account_id',[roomId]);
      if(!r.rows.length){ await rpAndDiscord('ブラックリストは空だよ'); return; }
      let t=''; for(const row of r.rows) t+=`・[picon:${row.account_id}]${await CW.nameById(row.account_id,currentMembers,roomId)}\n`;
      await rpAndDiscord(`${userName}ちゃん\n[info][title]ブラックリスト[/title]\n${t}[/info]`); return;
    }
    if(messageBody.startsWith('/blacklist-add ')){
      if(!await adminOnly()) return;
      const ids=messageBody.substring(15).trim().split(/\s+/).filter(Boolean);
      const added=[]; for(const id of ids){ await CW.addBlackList(roomId,id); added.push(`[picon:${id}]${await CW.nameById(id,currentMembers,roomId)}`); }
      await rpAndDiscord(`${added.join('、')}をブラックリストに追加したよ`); return;
    }
    if(messageBody.startsWith('/blacklist-del ')){
      if(!await adminOnly()) return;
      const ids=messageBody.substring(15).trim().split(/\s+/).filter(Boolean);
      const del=[]; for(const id of ids){ await dbQuery('DELETE FROM black_list WHERE room_id=$1 AND account_id=$2',[roomId,id]); del.push(`[picon:${id}]${await CW.nameById(id,currentMembers,roomId)}`); }
      await rpAndDiscord(`${del.join('、')}をブラックリストから削除したよ`); return;
    }
    if(messageBody==='/today'){
      const jst=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));
      let msg=`[info][title]今日の情報だよ[/title]今日は${jst.toLocaleDateString('ja-JP',{year:'numeric',month:'long',day:'numeric'})}だよっ！`;
      const ev=await getTodaysEvents();
      if(ev.length) ev.forEach(e=>{ msg+=`\n今日は${e}だよっ！`; }); else msg+='\n今日は特に登録されたイベントはないみたい。';
      await rpAndDiscord(`${userName}ちゃん\n\n${msg}[/info]`);
    }
    if(!isDirectChat&&messageBody==='/member'){
      if(currentMembers.length){ let r='[info][title]メンバー一覧[/title]\n'; currentMembers.forEach(m=>{r+=`・${m.name} (${m.role})\n`;}); await CW.send(roomId,r+'[/info]'); }
    }
    if(!isDirectChat&&messageBody==='/member-name'){
      if(currentMembers.length) await CW.send(roomId,`[info][title]メンバー名一覧[/title]\n${currentMembers.slice().sort((a,b)=>a.account_id-b.account_id).map(m=>m.name).join('\n')}[/info]`);
    }
    if(!isDirectChat&&messageBody==='/info'){
      const ri=await CW.roomInfo(roomId); if(!ri) return;
      const ip=ri.icon_path||''; const il=ip?(ip.startsWith('http')?ip:`https://appdata.chatwork.com${ip}`):'なし';
      await CW.send(roomId,`[info][title]この部屋の情報だよ[/title]部屋名：${ri.name}\nメンバー数：${currentMembers.length}人\n管理者数：${currentMembers.filter(m=>m.role==='admin').length}人\nルームID：${roomId}\nファイル数：${ri.file_num||0}\nメッセージ数：${ri.message_num||0}\nアイコン：${il}\n管理者一覧：${currentMembers.filter(m=>m.role==='admin').map(m=>m.name).join(', ')||'なし'}[/info]`); return;
    }
    if(messageBody==='/romera'){ const d=await getTodayCounts(roomId); await CW.send(roomId,await buildRankingMsg('メッセージ数ランキングだよ',d,currentMembers,roomId)); }
    if(messageBody==='/points'){
      const r=await dbQuery('SELECT point FROM points WHERE room_id=$1 AND account_id=$2',[roomId,accountId]);
      await rpAndDiscord(`${userName}ちゃんの現在のポイントは ${r.rowCount>0?r.rows[0].point:0}pt だよ！`); return;
    }
    if(messageBody==='/points-all'){
      const r=await dbQuery('SELECT account_id,point FROM points WHERE room_id=$1 ORDER BY point DESC',[roomId]);
      if(!r.rowCount){ await rpAndDiscord('まだポイントを持ってる人がいないみたい'); return; }
      let msg='[info][title]ポイントランキング[/title]\n';
      for(let i=0;i<r.rows.length;i++){ const n=await CW.nameById(r.rows[i].account_id,currentMembers,roomId); msg+=`${i+1}位：[picon:${r.rows[i].account_id}]${n} ${r.rows[i].point}pt`; if(i<r.rows.length-1) msg+='\n[hr]'; msg+='\n'; }
      await rpAndDiscord(msg+'[/info]'); return;
    }
    if(messageBody.startsWith('/send ')){
      const [tid,pts]=messageBody.substring(6).trim().split(/\s+/); const sp=parseInt(pts);
      if(!tid||isNaN(sp)||sp<=0){ await rpAndDiscord('つかいかたは /send {ユーザーID} {ポイント} だよ'); return; }
      const my=await dbQuery('SELECT point FROM points WHERE room_id=$1 AND account_id=$2',[roomId,accountId]);
      const mp=my.rowCount>0?parseInt(my.rows[0].point):0;
      if(mp<sp){ await rpAndDiscord(`ポイントが足りないよ！今持ってるのは ${mp}pt だよ`); return; }
      await dbQuery(`UPDATE points SET point=point-$1 WHERE room_id=$2 AND account_id=$3`,[sp,roomId,accountId]);
      await dbQuery(`INSERT INTO points (room_id,account_id,point) VALUES ($1,$2,$3) ON CONFLICT (room_id,account_id) DO UPDATE SET point=points.point+$3,updated_at=NOW()`,[roomId,tid,sp]);
      await rpAndDiscord(`[picon:${tid}]${await CW.nameById(tid,currentMembers,roomId)}に ${sp}pt 送ったよ！`); return;
    }
    if(messageBody.startsWith('/point-add ')){
      if(!['10911090','9553691'].includes(String(accountId))){ await rpAndDiscord('このコマンドは使えないよ！'); return; }
      const [tid,pts]=messageBody.substring(11).trim().split(/\s+/); const ap=parseInt(pts);
      if(!tid||isNaN(ap)||ap<=0) return;
      await dbQuery(`INSERT INTO points (room_id,account_id,point) VALUES ($1,$2,$3) ON CONFLICT (room_id,account_id) DO UPDATE SET point=points.point+$3,updated_at=NOW()`,[roomId,tid,ap]);
      await rpAndDiscord(`[picon:${tid}]${await CW.nameById(tid,currentMembers,roomId)}に ${ap}pt 追加したよ！`); return;
    }
    if(messageBody.startsWith('/point-del ')){
      if(!['10911090','9553691'].includes(String(accountId))){ await rpAndDiscord('このコマンドは使えないよ！'); return; }
      const [tid,pts]=messageBody.substring(11).trim().split(/\s+/); const dp=parseInt(pts);
      if(!tid||isNaN(dp)||dp<=0) return;
      await dbQuery(`INSERT INTO points (room_id,account_id,point) VALUES ($1,$2,0) ON CONFLICT (room_id,account_id) DO UPDATE SET point=GREATEST(points.point-$3,0),updated_at=NOW()`,[roomId,tid,dp]);
      await rpAndDiscord(`[picon:${tid}]${await CW.nameById(tid,currentMembers,roomId)}から ${dp}pt 削除したよ！`); return;
    }
    if(messageBody.startsWith('/fever ')){
      if(!await adminOnly()) return;
      const a=messageBody.substring(7).trim(); const mm=a.match(/^(\d+)m$/),hm=a.match(/^(\d+)h$/);
      let s=mm?parseInt(mm[1])*60:hm?parseInt(hm[1])*3600:0;
      if(s<=0||s>10800){ await rpAndDiscord('時間の指定がおかしいよ！5分なら 5m、3時間なら 3h（最大3時間）'); return; }
      const ea=new Date(Date.now()+s*1000);
      await dbQuery(`INSERT INTO fever (room_id,ends_at) VALUES ($1,$2) ON CONFLICT (room_id) DO UPDATE SET ends_at=$2`,[roomId,ea]);
      await rpAndDiscord(`フィーバータイム開始！${ea.toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})} まで獲得ポイント10倍だよっ！`); return;
    }
    if(messageBody.startsWith('/ng ')){
      if(!await adminOnly()) return;
      const w=messageBody.substring(4).trim(); if(!w) return;
      await dbQuery('INSERT INTO ng_words (room_id,word) VALUES ($1,$2) ON CONFLICT DO NOTHING',[roomId,w]);
      await rpAndDiscord(`「${w}」をNGワードに登録したよ！`); return;
    }
    if(messageBody.startsWith('/ok ')){
      if(!await adminOnly()) return;
      const w=messageBody.substring(4).trim(); if(!w) return;
      await dbQuery('DELETE FROM ng_words WHERE room_id=$1 AND word=$2',[roomId,w]);
      await rpAndDiscord(`「${w}」をNGワードから削除したよ！`); return;
    }
    if(messageBody==='/ng-check'){
      if(!await adminOnly()) return;
      const r=await dbQuery('SELECT word FROM ng_words WHERE room_id=$1 ORDER BY created_at',[roomId]);
      if(!r.rowCount){ await rpAndDiscord('NGワードはまだ登録されてないよ'); return; }
      await rpAndDiscord(`[info][title]NGワード一覧[/title]\n${r.rows.map(x=>`・${x.word}`).join('\n')}[/info]`); return;
    }
    if(messageBody==='/komekasegi'){
      const ms=['コメ稼ぎだよっ！','過疎だね…','静かすぎて風の音が聞こえる気がした','みんな寝落ちしちゃった？','ここって無人島かな？','今日も平和だね','誰か生きてるかな','砂漠のオアシス状態','コメントが凍結してる…','しーん……'];
      for(let i=0;i<10;i++){ await CW.send(roomId,ms[Math.floor(Math.random()*ms.length)]); if(i<9) await new Promise(r=>setTimeout(r,1000)); }
    }
    if(!isDirectChat&&messageBody.startsWith('/kick ')&&isSenderAdmin){
      const ids=messageBody.substring(6).trim().split(/\s+/).filter(Boolean); const kicked=[];
      for(const tid of ids){
        const fm=await CW.members(roomId); const tgt=fm.find(m=>String(m.account_id)===tid); if(!tgt) continue;
        const ad=fm.filter(m=>m.role==='admin'&&String(m.account_id)!==tid).map(m=>String(m.account_id)); if(!ad.length) continue;
        const me=fm.filter(m=>m.role==='member'&&String(m.account_id)!==tid).map(m=>String(m.account_id));
        const ro=fm.filter(m=>m.role==='readonly'&&String(m.account_id)!==tid).map(m=>String(m.account_id));
        const p=new URLSearchParams(); if(ad.length) p.append('members_admin_ids',ad.join(',')); if(me.length) p.append('members_member_ids',me.join(',')); if(ro.length) p.append('members_readonly_ids',ro.join(','));
        await apiCallLimiter(); await axios.put(`https://api.chatwork.com/v2/rooms/${roomId}/members`,p,{headers:{'X-ChatWorkToken':CHATWORK_API_TOKEN}}).catch(()=>{});
        kicked.push(`[picon:${tid}]${await CW.nameById(tid,fm,roomId)}`);
      }
      if(kicked.length) await CW.send(roomId,`${kicked.join('、')}をキックしたよっ！`); return;
    }
    if(!isDirectChat&&messageBody.startsWith('/mute ')&&isSenderAdmin){
      const ids=messageBody.substring(6).trim().split(/\s+/).filter(Boolean); const muted=[];
      for(const tid of ids){
        const fm=await CW.members(roomId); const tgt=fm.find(m=>String(m.account_id)===tid); if(!tgt||tgt.role==='readonly') continue;
        const ad=fm.filter(m=>m.role==='admin'&&String(m.account_id)!==tid).map(m=>String(m.account_id)); if(!ad.length) continue;
        const me=fm.filter(m=>m.role==='member'&&String(m.account_id)!==tid).map(m=>String(m.account_id));
        const ro=[...fm.filter(m=>m.role==='readonly').map(m=>String(m.account_id)),tid];
        const p=new URLSearchParams(); if(ad.length) p.append('members_admin_ids',ad.join(',')); if(me.length) p.append('members_member_ids',me.join(',')); if(ro.length) p.append('members_readonly_ids',ro.join(','));
        await apiCallLimiter(); await axios.put(`https://api.chatwork.com/v2/rooms/${roomId}/members`,p,{headers:{'X-ChatWorkToken':CHATWORK_API_TOKEN}}).catch(()=>{});
        await CW.addBlackList(roomId,tid); muted.push(`[picon:${tid}]${await CW.nameById(tid,fm,roomId)}`);
      }
      if(muted.length) await CW.send(roomId,`${muted.join('、')}を閲覧のみにしたよっ！`); return;
    }
    if(!isDirectChat&&messageBody==='/disself'){
      const cu=currentMembers.find(m=>m.account_id===accountId); if(!cu) return;
      const ad=currentMembers.filter(m=>m.role==='admin'&&m.account_id!==accountId).map(m=>m.account_id);
      const me=currentMembers.filter(m=>m.role==='member'&&(cu.role==='admin'||m.account_id!==accountId)).map(m=>m.account_id);
      const ro=currentMembers.filter(m=>m.role==='readonly').map(m=>m.account_id);
      if(cu.role==='admin') me.push(accountId);
      else if(cu.role==='member') ro.push(accountId);
      const p=new URLSearchParams(); if(ad.length) p.append('members_admin_ids',ad.join(',')); if(me.length) p.append('members_member_ids',me.join(',')); if(ro.length) p.append('members_readonly_ids',ro.join(','));
      await apiCallLimiter(); await axios.put(`https://api.chatwork.com/v2/rooms/${roomId}/members`,p,{headers:{'X-ChatWorkToken':CHATWORK_API_TOKEN}}).catch(()=>{}); return;
    }
    if(messageBody==='/jirai-test'){
      if(!await adminOnly()) return;
      const t=await loadJiraiToggles(); const p=await CW.getJiraiProb(accountId,isSenderAdmin);
      await rpAndDiscord(`地雷テスト\n現在の確率: ${(p*100).toFixed(2)}%\nルームID: ${roomId}\nLOG_ROOM_ID: ${LOG_ROOM_ID}\n一致: ${String(roomId)===LOG_ROOM_ID}\nアカウントID: ${accountId}\n管理者: ${isSenderAdmin}\n\nトグル:\ngakusei:${t.gakusei} nyanko_a:${t.nyanko_a} milk:${t.milk} admin:${t.admin} yuyuyu:${t.yuyuyu}`); return;
    }
    if(messageBody==='/jirai-force'){
      if(!await adminOnly()) return;
      const admins=currentMembers.filter(m=>m.role==='admin');
      if(admins.length){ const ra=admins[Math.floor(Math.random()*admins.length)]; await rpAndDiscord(`${userName}ちゃん\n地雷ふんじゃったね…\n[To:${ra.account_id}]${ra.name}に罰ゲームを考えてもらってね！（強制発動テスト）`); } return;
    }
    for(const [tn,label,prob] of [['gakusei','学生の確率UP','25%'],['nyanko_a','nyanko_aの確率UP','100%'],['milk','牛乳の確率UP','50%'],['admin','管理者の確率UP','25%'],['yuyuyu','ゆゆゆの確率UP','75%']]){
      if(messageBody===`/${tn}`){
        if(!await adminOnly()) return;
        const t=await loadJiraiToggles(); const ns=!t[tn]; await saveJiraiToggle(tn,ns);
        await CW.send(roomId,ns?`${label}がONになりました。(確率：${prob})`:`${label}がOFFになりました。`); return;
      }
    }
    if(messageBody==='/help'){
      const common='[info][title]コマンド一覧だよっ！[/title]/help - このヘルプを表示\n[hr]/today - 今日の日付とイベント\n[hr]/test - あなたとこの部屋の情報\n[hr]/info - この部屋の情報\n[hr]/member - メンバー一覧\n[hr]/member-name - メンバー名一覧\n[hr]/romera - 今日のメッセージ数ランキング\n[hr]/message-total - 累計発言数ランキング\n[hr]/points - 自分のポイントを確認\n[hr]/points-all - 全員のポイントランキング\n[hr]/send {ID} {pt} - ポイントを送る\n[hr]/yes-or-no - yes/noをランダム回答\n[hr]/wiki 検索ワード - Wikipedia検索\n[hr]/lyric URL - 歌詞を取得\n[hr]/song-typing-info 曲ID - 歌詞タイピング情報\n[hr]/alarm YYYY-MM-DD HH:MM メッセージ - アラーム設定\n[hr]/scratch-user ユーザー名 - Scratchユーザー情報\n[hr]/scratch-project プロジェクトID - Scratch作品情報\n[hr]/komekasegi - 過疎対策コメ連打\n[hr]/disself - 自分の権限を下げる\n[hr]おみくじ / おみくじ10連 / /yes-or-no - 運試し[/info]';
      const admin=isSenderAdmin?'\n[info][title]管理者専用コマンドだよっ！[/title]/info {ルームID} - 別ルームの情報を取得\n[hr]/kick {ID}... - キック\n[hr]/mute {ID}... - 閲覧のみに変更\n[hr]/blacklist - ブラックリスト確認\n[hr]/blacklist-add {ID}... - ブラックリストに追加\n[hr]/blacklist-del {ID}... - ブラックリストから削除\n[hr]/fever {時間} - フィーバータイム（例: 5m, 1h）\n[hr]/ng {言葉} - NGワード登録\n[hr]/ok {言葉} - NGワード削除\n[hr]/ng-check - NGワード一覧\n[hr]/gakusei /nyanko_a /milk /admin /yuyuyu - 地雷確率トグル\n[hr]/jirai-test - 地雷確率デバッグ\n[hr]/jirai-force - 地雷強制発動テスト[/info]':'';
      await rpAndDiscord(`${userName}ちゃん\n${common}${admin}`); return;
    }
    const responses={'はんせい':`[To:10911090] はんせい\n${userName}に呼ばれてるよっ！`,'ゆゆゆ':`[To:10911090] ゆゆゆ\n${userName}に呼ばれてるよっ！`,'からめり':`[To:10337719] からめり\n${userName}に呼ばれてるよっ！`,'学生':`[To:9553691] がっくせい\n${userName}に呼ばれてるよっ！`,'みおん':'はーい！','いろいろあぷり':'https://shiratama-kotone.github.io/any-app/\nどーぞ！','喘いでください湊音様':'そう簡単に喘ぐとでも思った？残念！ぼくは喘ぎません...っ♡///','おやすみ':'おやすみ！','おはよう':'おはよう！','プロセカやってくる':'がんばれ！','せっ':'くす','精':'子','114':'514','ちん':'ちんㅤ','富士山':'3776m!','TOALL':'[toall...するわけないじゃん！','botのコードください':'https://github.com/shiratama-kotone/cw-bot\nどーぞ！','1+1=':'1!','トイレいってくる':'漏らさないでねっ！','6':'9','Git':'hub'};
    if(responses[messageBody]) await CW.send(roomId,responses[messageBody]);
    if(messageBody==='/test'){
      const jst=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));
      const ri=await CW.roomInfo(roomId);
      await rpAndDiscord(`[info][title]あなたの情報だよっ！[/title]ユーザーID：${accountId}\nユーザー名：${userName}\nルームID：${roomId}\nルーム名：${ri?ri.name:'取得失敗'}\nメッセージID：${messageId}\n時間：${jst.toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}[/info]`);
    }
  } catch(e){ console.error('[WebHook] 処理エラー:',e.message); }
}

// ============================================================
// 歌詞タイピング情報
// ============================================================
async function getSongTypingInfo(songId) {
  try {
    const res=await axios.get('https://shiratama-kotone.github.io/typing-game/song-typing/lyrics-data.js',{timeout:10000});
    const mx=res.data.match(/(?:const|var|let)\s+lyricsData\s*=\s*(\[[\s\S]*\])\s*;/);
    if(!mx) return '歌詞データの解析に失敗しちゃった';
    let data; try{ data=(new Function(`return ${mx[1]};`))(); } catch{ return '歌詞データの解析に失敗しちゃった'; }
    const songs=data.filter(s=>s.id===songId);
    if(!songs.length) return `曲ID「${songId}」が見つからなかったよ`;
    const results=[];
    for(const song of songs){
      let total=0; song.lyrics.forEach(l=>{total+=l.kana.length;});
      let dur='取得失敗';
      try{ const yr=await axios.get(`https://www.youtube.com/watch?v=${song.youtubeId}`,{timeout:5000}); const dm=yr.data.match(/"lengthSeconds":"(\d+)"/); if(dm){ const s=parseInt(dm[1]); dur=`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`; } } catch{}
      let avg='計算中...';
      if(dur!=='取得失敗'){ const [m,s]=dur.split(':').map(Number); avg=`${(total/(m*60+s)).toFixed(2)}打/秒`; }
      results.push(`[info][title]${song.title}の歌詞タイピング情報[/title]総打数：${total}\n曲の長さ：${dur}\n必要平均タイプ速度：${avg}\nライン数：${song.lyrics.length}[/info]`);
    }
    return results.join('\n');
  } catch(e){ return `エラーが発生しちゃった: ${e.message}`; }
}

// ============================================================
// Express.js
// ============================================================
app.use(express.json());
app.use(express.urlencoded({extended:true}));

app.post('/webhook', async (req,res) => {
  try {
    const ev=req.body.webhook_event||req.body;
    if(ev?.room_id){
      ev.webhook_event_type=req.body.webhook_event_type||'message_created';
      ev.webhook_event_time=req.body.webhook_event_time;
      await processWebHook(ev);
      res.status(200).json({status:'success'});
    } else res.status(400).json({error:'Invalid webhook data'});
  } catch { res.status(500).json({error:'Internal server error'}); }
});

app.get('/',(req,res)=>res.json({status:'OK',message:'ぼくは元気に稼働中！',timestamp:new Date().toISOString(),dbAvailable}));

app.get('/status',async(req,res)=>{
  const t=await loadJiraiToggles();
  res.json({status:'元気！',timestamp:new Date().toISOString(),uptime:process.uptime(),dbAvailable,jiraiToggles:t});
});

app.post('/msg-post', async (req,res) => {
  try {
    const {roomid,msg}=req.body;
    if(!roomid||!msg) return res.status(400).json({status:'error',message:'ルームIDとメッセージ内容は必須です'});
    if(!await CW.isMember(roomid)) return res.status(400).json({status:'error',message:'ルームに参加していません'});
    const converted=msg.replace(/\[返信\s+aid=(\d+)\s+to=([^\]]+)\]/g,'[rp aid=$1 to=$2]').replace(/\[引用\s+aid=(\d+)\s+time=(\d+)\]([\s\S]*?)\[\/引用\]/g,'[qt][qtmeta aid=$1 time=$2]$3[/qt]');
    const id=await CW.send(roomid,converted);
    if(id) res.json({status:'success',messageId:id,convertedMsg:converted});
    else res.status(500).json({status:'error',message:'メッセージ送信に失敗しました'});
  } catch(e){ res.status(500).json({status:'error',message:e.message}); }
});

// ============================================================
// 定期実行タスク
// ============================================================
async function sendDailyGreeting() {
  const jst=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));
  const tf=jst.toLocaleDateString('ja-JP',{year:'numeric',month:'long',day:'numeric'});
  const td=jst.toISOString().split('T')[0];
  const ev=await getTodaysEvents();
  let cwMsg=`[info][title]日付変更だよ[/title]今日は${tf}だよっ！`;
  if(ev.length) ev.forEach(e=>{cwMsg+=`\n今日は${e}だよっ！`;}); cwMsg+='[/info]';
  for(const r of DIRECT_CHAT_WITH_DATE_CHANGE){
    if(mem.lastSentDates.get(r)===td) continue;
    const ok=await CW.send(r,cwMsg);
    if(ok){ mem.lastSentDates.set(r,td); mem.messageCounts.set(r,{}); mem.roomResetDates.set(r,td); }
  }
  if(discordClient){
    try{
      const ch=await discordClient.channels.fetch(DISCORD_DATE_CHANGE_CHANNEL_ID);
      if(ch){ let dm=`日付変更！今日は${tf}だよっ！`; if(ev.length) ev.forEach(e=>{dm+=`\n今日は${e}だよっ！`;}); await ch.send(dm); }
    } catch(e){ console.error('[Discord] 日付変更通知エラー:',e.message); }
  }
}
async function sendNightMsg(){ for(const r of DIRECT_CHAT_WITH_DATE_CHANGE) await CW.send(r,'11時だよ！ぼくはもう眠くなってきちゃった…').catch(()=>{}); }
async function ohayosekai(){ for(const r of DIRECT_CHAT_WITH_DATE_CHANGE) await CW.send(r,'おはようせかい').catch(()=>{}); }
async function sendMorningMsg(){
  for(const r of DIRECT_CHAT_WITH_DATE_CHANGE) await CW.send(r,'みんなおはよう！\nぼくはまだ眠いなぁ').catch(()=>{});
  for(const area of WEATHER_AREAS){
    const w=await CW.weather(area.code); if(!w?.forecasts?.length) continue;
    const t=w.forecasts[0]; const mx=t.temperature.max?`${t.temperature.max.celsius}℃`:'不明'; const mn=t.temperature.min?.celsius?`${t.temperature.min.celsius}℃`:null;
    let msg=`[info][title]たぶん${area.name}の今日の天気予報[/title]天気は${t.telop||'不明'}だよ\n最高気温は${mx}だよ`; if(mn) msg+=`\n最低気温はたぶん${mn}だよ`; msg+='\n天気概況文はいらない！\nぼくの判断。[/info]';
    for(const r of DIRECT_CHAT_WITH_DATE_CHANGE){ await CW.send(r,msg).catch(()=>{}); await new Promise(r=>setTimeout(r,500)); }
  }
}
async function sendTomorrowWeather(){
  for(const area of WEATHER_AREAS){
    const w=await CW.weather(area.code); if(!w?.forecasts||w.forecasts.length<2) continue;
    const t=w.forecasts[1]; const mx=t.temperature.max?`${t.temperature.max.celsius}℃`:'不明'; const mn=t.temperature.min?.celsius?`${t.temperature.min.celsius}℃`:null;
    let msg=`[info][title]たぶん${area.name}の明日の天気予報[/title]天気は${t.telop||'不明'}だよ\n最高気温は${mx}だよ`; if(mn) msg+=`\n最低気温はたぶん${mn}だよ`; msg+='\n天気概況文はいらない！\nぼくの判断。[/info]';
    for(const r of DIRECT_CHAT_WITH_DATE_CHANGE){ await CW.send(r,msg).catch(()=>{}); await new Promise(r=>setTimeout(r,500)); }
  }
}
async function sendDailyRanking(label){
  for(const r of DIRECT_CHAT_WITH_DATE_CHANGE){
    const d=await getTodayCounts(r); const ms=await CW.members(r);
    await CW.send(r,(label?label+'\n':'')+await buildRankingMsg('コメ数ランキング！',d,ms,r)).catch(()=>{});
  }
}
async function checkEQ(){
  try{
    const r=await axios.get('https://api.p2pquake.net/v2/history?codes=551&limit=1'); const d=r.data;
    if(!d?.length||!d[0].earthquake||d[0].earthquake.maxScale<10) return;
    const eq=d[0]; const tr=['福岡','北海道','大阪']; let notify=false;
    if(eq.earthquake.maxScale>=30) notify=true;
    else if(eq.earthquake.points?.some(p=>p.scale>=10&&tr.some(t=>(p.pref||'').includes(t)||(p.addr||'').includes(t)))) notify=true;
    else if(tr.some(t=>(eq.earthquake.hypocenter?.name||'').includes(t))) notify=true;
    if(!notify||eq.id===mem.lastEarthquakeId) return;
    mem.lastEarthquakeId=eq.id;
    const sm={10:'1',20:'2',30:'3',40:'4',45:'5弱',50:'5強',55:'6弱',60:'6強',70:'7'};
    const scale=sm[eq.earthquake.maxScale]||(eq.earthquake.maxScale/10);
    const dn=new Date(eq.earthquake.time);
    const mag=eq.earthquake.hypocenter?.magnitude; const magT=(mag===null||mag===-1||mag===undefined)?'まだわかんない':mag;
    const place=eq.earthquake.hypocenter?.name&&eq.earthquake.hypocenter.name!=='不明'?` ${eq.earthquake.hypocenter.name} で`:'';
    const msg=`[info][title]地震情報だよ[/title]${dn.getFullYear()}年${dn.getMonth()+1}月${dn.getDate()}日 ${String(dn.getHours()).padStart(2,'0')}:${String(dn.getMinutes()).padStart(2,'0')} に${place}震度${scale}の地震が発生したよ。\nマグニチュードは${magT}\n引き続き情報に注意してね！[/info]`;
    for(const r of DIRECT_CHAT_WITH_DATE_CHANGE) await CW.send(r,msg).catch(()=>{});
  } catch{}
}
async function checkAlarms(){
  const r=await dbQuery('SELECT * FROM alarms WHERE scheduled_time<=$1',[new Date()]);
  for(const a of r.rows){
    if(a.room_id) await CW.send(a.room_id,a.message).catch(()=>{});
    if(a.discord_channel_id&&discordClient){
      try{ const ch=await discordClient.channels.fetch(a.discord_channel_id); if(ch) await ch.send(`⏰ ${a.message}`); } catch{}
    }
    await dbQuery('DELETE FROM alarms WHERE id=$1',[a.id]);
  }
}
async function checkNhkNews(){
  try{
    const r=await axios.get('https://api.web.nhk/sokuho/news/sokuho_news.xml',{timeout:8000,headers:{'User-Agent':'ChatworkBot/1.0'}});
    const xml=r.data; const fm=xml.match(/<flashNews[^>]*flag="(\d+)"/); if(!fm||fm[1]!=='1') return;
    const rm=xml.match(/<report[^>]*id="([^"]+)"[^>]*>/); const lm=xml.match(/<line>([\s\S]*?)<\/line>/); if(!rm||!lm) return;
    const rid=rm[1]; const lt=lm[1].replace(/<!\[CDATA\[|\]\]>/g,'').trim();
    if(rid===mem.lastNhkNewsId) return; mem.lastNhkNewsId=rid;
    const lnk=(xml.match(/link="([^"]+)"/))?.[1]||'';
    const msg=`[info][title]NHK速報[/title]${lt}${lnk?'\n'+lnk:''}[/info]`;
    for(const r of DIRECT_CHAT_WITH_DATE_CHANGE){ await CW.send(r,msg).catch(()=>{}); await new Promise(r=>setTimeout(r,300)); }
  } catch{}
}
const WN={暴風警報:'',大雨警報:'',洪水警報:'',大雪警報:'',暴風雪警報:'',波浪警報:'',高潮警報:'',暴風注意報:'',大雨注意報:'',洪水注意報:'',大雪注意報:'',雷注意報:'',濃霧注意報:'',乾燥注意報:'',強風注意報:'',波浪注意報:'',高潮注意報:'',霜注意報:'',低温注意報:''};
async function checkWarnings(){
  try{
    const d=(await axios.get('https://www.jma.go.jp/bosai/warning/data/warning/map.json',{timeout:8000,headers:{'User-Agent':'ChatworkBot/1.0'}})).data;
    for(const pc of ['270000','400000','010000','230000','470000']){
      const pd=d[pc]; if(!pd) continue;
      const cw=new Set(); if(pd.warning?.items) for(const it of pd.warning.items) if(it.warnings) for(const w of it.warnings) if(w.status==='発表'||w.status==='継続') cw.add(w.type);
      const pw=mem.sentWarnings.get(pc)||new Set();
      const issued=[...cw].filter(w=>!pw.has(w)); const lifted=[...pw].filter(w=>!cw.has(w));
      if(issued.length){ const ic=issued.map(w=>`${WN[w]} ${w}`).join('、'); const msg=`[info][title]気象警報・注意報 発令[/title]${pd.areaName||pc}に\n${ic}\nが発令されました。引き続き情報に注意してね！[/info]`; for(const r of DIRECT_CHAT_WITH_DATE_CHANGE){ await CW.send(r,msg).catch(()=>{}); await new Promise(r=>setTimeout(r,300)); } }
      if(lifted.length){ const ic=lifted.map(w=>`${WN[w]} ${w}`).join('、'); const msg=`[info][title]気象警報・注意報 解除[/title]${pd.areaName||pc}の\n${ic}\nが解除されました。[/info]`; for(const r of DIRECT_CHAT_WITH_DATE_CHANGE){ await CW.send(r,msg).catch(()=>{}); await new Promise(r=>setTimeout(r,300)); } }
      mem.sentWarnings.set(pc,cw);
    }
  } catch{}
}
async function cleanup(){ const d=new Date(); d.setDate(d.getDate()-2); await dbQuery('DELETE FROM message_logs WHERE created_at<$1 AND room_id=$2',[d,LOG_ROOM_ID]).catch(()=>{}); }
async function send311(isMemorial){
  const y=new Date().getFullYear()-2011;
  const msg=isMemorial?`今日は3月11日。東日本大震災から${y}年が経ちました。\n2011年3月11日14時46分、日本は観測史上最大級の地震と大津波に見舞われ、多くの尊い命が失われました。\n今もなお、あの日の記憶や想いを胸に生きている方々がいます。\n\n普段の何気ない日常が、決して当たり前ではないことを改めて考える日でもあります。\n震災で亡くなられた方々、そして被災されたすべての方々に心を寄せたいと思います。\n\nまもなく14時46分です。\n犠牲になられた方々へ、黙祷を捧げましょう。`:'黙祷';
  for(const r of DIRECT_CHAT_WITH_DATE_CHANGE) await CW.send(r,msg).catch(()=>{});
}

cron.schedule('0 0 0 * * *',  async()=>{await ohayosekai(); await sendDailyGreeting();},{timezone:'Asia/Tokyo'});
cron.schedule('5 0 0 * * *',  async()=>await cleanup(),                                   {timezone:'Asia/Tokyo'});
cron.schedule('0 0 23 * * *', async()=>await sendNightMsg(),                               {timezone:'Asia/Tokyo'});
cron.schedule('0 55 23 * * *',async()=>await sendDailyRanking('日付変更の前のランキング'), {timezone:'Asia/Tokyo'});
cron.schedule('0 59 23 * * *',async()=>await sendDailyRanking('今日のコメ数ランキングだよっ！'), {timezone:'Asia/Tokyo'});
cron.schedule('0 0 6 * * *',  async()=>await sendMorningMsg(),                            {timezone:'Asia/Tokyo'});
cron.schedule('0 0 18 * * *', async()=>await sendTomorrowWeather(),                       {timezone:'Asia/Tokyo'});
cron.schedule('*/1 * * * *',  async()=>{ await checkEQ(); await checkAlarms(); await checkNhkNews(); await checkWarnings(); },{timezone:'Asia/Tokyo'});
cron.schedule('45 14 11 3 *', async()=>await send311(true),  {timezone:'Asia/Tokyo'});
cron.schedule('46 14 11 3 *', async()=>await send311(false), {timezone:'Asia/Tokyo'});

// ============================================================
// Discord
// ============================================================

// Chatworkタグ → Discord用テキスト変換
// [info][title]タイトル[/title]本文[/info] → **タイトル**\n本文
function cwToDiscordText(text) {
  return text
    .replace(/\[info\]\[title\]([\s\S]*?)\[\/title\]([\s\S]*?)\[\/info\]/g, (_,t,body)=>`**${t.trim()}**\n${body.trim()}`)
    .replace(/\[info\]([\s\S]*?)\[\/info\]/g, '$1')
    .replace(/\[title\]([\s\S]*?)\[\/title\]/g, '**$1**')
    .replace(/\[dtext:chatroom_member_is\]/g, 'メンバー「')
    .replace(/\[dtext:chatroom_leaved\]/g, 'が退席しました。')
    .replace(/\[dtext:chatroom_added\]/g, 'を追加しました。')
    .replace(/\[dtext:chatroom_chat_joined\]/g, 'チャットに参加しました。')
    .replace(/\[dtext:chatroom_description_is\]/g, '概要を「')
    .replace(/\[dtext:chatroom_changed\]/g, '」に変更しました。')
    .replace(/\[dtext:task_added\]/g, 'タスクを追加しました。')
    .replace(/\[dtext:task_edited\]/g, 'タスクを編集しました。')
    .replace(/\[dtext:task_deleted\]/g, 'このタスクは削除されました')
    .replace(/\[dtext:chatroom_deleted\]/g, '」を削除しました。')
    .replace(/\[dtext:chatroom_set\]/g, '」に設定しました。')
    .replace(/\[deleted\]/g, 'メッセージは削除されました')
    .replace(/\[piconname:\d+\]/g, '').replace(/\[picon:\d+\]/g, '')
    .replace(/\[To:\d+\]/g, '').replace(/\[rp aid=\d+ to=\d+-\d+\]\s*/g, '（返信）')
    .replace(/\[qt\][\s\S]*?\[\/qt\]/g, '（引用）')
    .replace(/\[hr\]/g, '──────────')
    .replace(/\[[^\]]+\]/g, '')
    .trim();
}

async function sendToDiscord(content) {
  if(!DISCORD_WEBHOOK_URL) return null;
  try{ return (await axios.post(DISCORD_WEBHOOK_URL+'?wait=true',{content},{headers:{'Content-Type':'application/json'}})).data.id||null; } catch{ return null; }
}

let discordClient = null;
const discordWebhookMsgIds = new Set();

if(DISCORD_BOT_TOKEN){
  discordClient = new Client({intents:[
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
  ], partials: [Partials.Channel, Partials.Message]});

  discordClient.once(Events.ClientReady, async(c)=>{
    console.log(`[Discord] bot起動: ${c.user.tag}`);
    const ADMIN_PERM = PermissionFlagsBits.ManageMessages;

    const cmds = [
      // ━━ 誰でも使えるコマンド ━━
      new SlashCommandBuilder().setName('help').setDescription('コマンド一覧を表示するよ'),
      new SlashCommandBuilder().setName('normal_omikuji').setDescription('普通のおみくじを引くよっ！（大凶が極端に多くないよ）'),
      new SlashCommandBuilder().setName('normal_omikuji_n').setDescription('普通のおみくじをN回引くよ（大凶が極端に多くないよ）').addIntegerOption(o=>o.setName('count').setDescription('回数（1〜10000）').setRequired(true).setMinValue(1).setMaxValue(10000)),
      new SlashCommandBuilder().setName('omikuji_n').setDescription('おみくじをN回引くよ（大凶99%版）').addIntegerOption(o=>o.setName('count').setDescription('回数（1〜10000）').setRequired(true).setMinValue(1).setMaxValue(10000)),
      new SlashCommandBuilder().setName('yes_or_no').setDescription('yes/noをランダム回答するよ'),
      new SlashCommandBuilder().setName('wiki').setDescription('Wikipediaを検索するよ').addStringOption(o=>o.setName('word').setDescription('検索ワード').setRequired(true)),
      new SlashCommandBuilder().setName('today').setDescription('今日の日付とイベントを表示するよ'),
      new SlashCommandBuilder().setName('lyric').setDescription('歌詞を取得するよ').addStringOption(o=>o.setName('url').setDescription('utaten.com/uta-net.com/atwiki.jpのURL').setRequired(true)),
      new SlashCommandBuilder().setName('scratch_user').setDescription('Scratchユーザー情報を表示するよ').addStringOption(o=>o.setName('username').setDescription('ユーザー名').setRequired(true)),
      new SlashCommandBuilder().setName('scratch_project').setDescription('Scratchプロジェクト情報を表示するよ').addStringOption(o=>o.setName('id').setDescription('プロジェクトID').setRequired(true)),
      new SlashCommandBuilder().setName('song_typing_info').setDescription('歌詞タイピング情報を表示するよ').addStringOption(o=>o.setName('id').setDescription('曲ID').setRequired(true)),
      new SlashCommandBuilder().setName('romera').setDescription('今日のメッセージ数ランキングを表示するよ（CWルーム415060980対象）'),
      new SlashCommandBuilder().setName('message_total').setDescription('累計発言数ランキングを表示するよ（CWルーム415060980対象）'),
      new SlashCommandBuilder().setName('alarm').setDescription('このチャンネルにアラームを設定するよ').addStringOption(o=>o.setName('datetime').setDescription('日時（YYYY-MM-DD HH:MM）').setRequired(true)).addStringOption(o=>o.setName('message').setDescription('メッセージ').setRequired(true)),
      new SlashCommandBuilder().setName('miaq').setDescription('メッセージをMake it a Quoteにするよ').addStringOption(o=>o.setName('message_id').setDescription('対象のメッセージID').setRequired(true)),
      new SlashCommandBuilder().setName('room_info').setDescription('CWルームの情報を表示するよ（要INFO_API_TOKEN）').addStringOption(o=>o.setName('room_id').setDescription('CWルームID').setRequired(true)),
      // ━━ 管理者専用コマンド ━━
      new SlashCommandBuilder().setName('clear').setDescription('メッセージを指定数削除するよ').addIntegerOption(o=>o.setName('count').setDescription('削除数（1〜100）').setRequired(true).setMinValue(1).setMaxValue(100)).setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('prohibit').setDescription('このチャンネルで発言禁止にするよ').addStringOption(o=>o.setName('duration').setDescription('時間（例: 5m, 1h、最大3h）').setRequired(true)).setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('release').setDescription('このチャンネルの発言禁止を解除するよ').setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('ban').setDescription('CWブラックリストに追加して閲覧のみにするよ').addStringOption(o=>o.setName('cw_account_id').setDescription('ChatworkアカウントID').setRequired(true)).setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('unban').setDescription('CWブラックリストから削除するよ').addStringOption(o=>o.setName('cw_account_id').setDescription('ChatworkアカウントID').setRequired(true)).setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('blacklist').setDescription('CWブラックリストを確認するよ').setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('kick').setDescription('CWルームからキックするよ').addStringOption(o=>o.setName('cw_account_id').setDescription('ChatworkアカウントID').setRequired(true)).setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('mute').setDescription('CWルームで閲覧のみにするよ').addStringOption(o=>o.setName('cw_account_id').setDescription('ChatworkアカウントID').setRequired(true)).setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('fever').setDescription('CWルームのフィーバータイムを開始するよ').addStringOption(o=>o.setName('duration').setDescription('時間（例: 5m, 1h、最大3h）').setRequired(true)).setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('ng_add').setDescription('CWルームにNGワードを登録するよ').addStringOption(o=>o.setName('word').setDescription('NGワード').setRequired(true)).setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('ng_del').setDescription('CWルームのNGワードを削除するよ').addStringOption(o=>o.setName('word').setDescription('削除するNGワード').setRequired(true)).setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('ng_check').setDescription('CWルームのNGワード一覧を表示するよ').setDefaultMemberPermissions(ADMIN_PERM),
    ].map(c=>c.toJSON());

    try{
      const rest=new REST({version:'10'}).setToken(DISCORD_BOT_TOKEN);
      await rest.put(Routes.applicationCommands(c.user.id),{body:cmds});
      console.log('[Discord] スラッシュコマンド登録完了');
    } catch(e){ console.error('[Discord] コマンド登録エラー:',e.message); }
  });

  discordClient.on(Events.InteractionCreate, async(interaction)=>{
    if(!interaction.isChatInputCommand()) return;
    const cmd=interaction.commandName;
    const isAdmin=interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)||false;
    const CW_ROOM=CW_ROOM_ID_FOR_DISCORD;

    // Discord投稿規制チェック用ヘルパー
    const checkProhibit=async()=>{
      if(isAdmin) return false;
      const r=await dbQuery('SELECT ends_at FROM discord_prohibit WHERE channel_id=$1 AND ends_at>NOW()',[interaction.channelId]);
      return r.rowCount>0;
    };

    try{
      await interaction.deferReply();

      // ── /help ──
      if(cmd==='help'){
        const lines=[
          '**コマンド一覧**',
          '`/normal_omikuji` - 普通のおみくじ（均等な確率）',
          '`/normal_omikuji_n [count]` - 普通のおみくじN連（均等な確率）',
          '`/omikuji_n [count]` - おみくじN連（大凶99%版）',
          '※ 「おみくじ」「おみくじXX連」「おやすみ」「おはよう」はメッセージ送信で反応するよ',
          '`/yes_or_no` - yes/noをランダム回答',
          '`/wiki [word]` - Wikipedia検索',
          '`/today` - 今日の日付とイベント',
          '`/lyric [url]` - 歌詞取得（utaten/uta-net/atwiki）',
          '`/scratch_user [username]` - Scratchユーザー情報',
          '`/scratch_project [id]` - Scratchプロジェクト情報',
          '`/song_typing_info [id]` - 歌詞タイピング情報',
          '`/romera` - 今日のメッセージ数ランキング（CW）',
          '`/message_total` - 累計発言数ランキング（CW）',
          '`/alarm [datetime] [message]` - このチャンネルにアラーム設定',
          '`/miaq [message_id]` - Make it a Quote',
          '`/room_info [room_id]` - CWルーム情報表示',
          '',
          '**管理者専用**',
          '`/clear [count]` - メッセージを指定数削除（最大100）',
          '`/prohibit [duration]` - このチャンネルで発言禁止（例: 5m, 1h）',
          '`/release` - このチャンネルの発言禁止を解除',
          '`/ban [cw_id]` - CWブラックリスト追加 + 閲覧のみ',
          '`/unban [cw_id]` - CWブラックリストから削除',
          '`/blacklist` - CWブラックリスト確認',
          '`/kick [cw_id]` - CWルームからキック',
          '`/mute [cw_id]` - CWルームで閲覧のみ',
          '`/fever [duration]` - CWフィーバータイム（例: 5m, 1h）',
          '`/ng_add [word]` - CW NGワード登録',
          '`/ng_del [word]` - CW NGワード削除',
          '`/ng_check` - CW NGワード一覧',
        ];
        await interaction.editReply(lines.join('\n')); return;
      }

      // ── おみくじ系スラッシュコマンド ──
      if(cmd==='normal_omikuji'){ await interaction.editReply(`普通のおみくじの結果は…\n**${CW.drawNormalOmikuji()}**\nだよっ！`); return; }
      if(cmd==='normal_omikuji_n'){
        const n=Math.min(interaction.options.getInteger('count'),10000);
        const rs=Array.from({length:n},()=>CW.drawNormalOmikuji());
        await interaction.editReply(`普通のおみくじ${n}連の結果は…\n**${CW.summarizeOmikuji(rs)}**\nだよっ！`); return;
      }
      if(cmd==='omikuji_n'){
        const n=Math.min(interaction.options.getInteger('count'),10000);
        const rs=Array.from({length:n},()=>CW.drawOmikuji());
        await interaction.editReply(`おみくじ${n}連（大凶99%版）の結果は…\n**${CW.summarizeOmikuji(rs)}**\nだよっ！`); return;
      }
      if(cmd==='yes_or_no'){ await interaction.editReply(`答えは「**${await CW.yesOrNo()}**」だよっ！`); return; }

      // ── wiki ──
      if(cmd==='wiki'){ await interaction.editReply((await CW.wikipedia(interaction.options.getString('word'))).substring(0,1900)); return; }

      // ── today ──
      if(cmd==='today'){
        const jst=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));
        const ev=await getTodaysEvents();
        let msg=`今日は**${jst.toLocaleDateString('ja-JP',{year:'numeric',month:'long',day:'numeric'})}**だよっ！`;
        if(ev.length) ev.forEach(e=>{msg+=`\n今日は${e}だよっ！`;}); await interaction.editReply(msg); return;
      }

      // ── lyric ──
      if(cmd==='lyric'){
        const url=interaction.options.getString('url');
        if(!(url.includes('utaten.com')||url.includes('uta-net.com')||url.includes('atwiki.jp'))){ await interaction.editReply('対応URLはutaten.com、uta-net.com、atwiki.jpだよ！'); return; }
        const lyr=await CW.lyrics(url);
        // Chatworkタグを除去してDiscord用に変換
        const disc=lyr.replace(/\[info\]\[title\]([^\[]*)\[\/title\]/g,'**$1**\n').replace(/\[\/info\]/g,'').replace(/\[.*?\]/g,'');
        await interaction.editReply(disc.substring(0,1900)); return;
      }

      // ── scratch ──
      if(cmd==='scratch_user'){ const r=await CW.scratchUser(interaction.options.getString('username')); await interaction.editReply(r.replace(/\[.*?\]/g,'').substring(0,1900)); return; }
      if(cmd==='scratch_project'){ const r=await CW.scratchProject(interaction.options.getString('id')); await interaction.editReply(r.replace(/\[.*?\]/g,'').substring(0,1900)); return; }

      // ── song_typing_info ──
      if(cmd==='song_typing_info'){ const r=await getSongTypingInfo(interaction.options.getString('id')); await interaction.editReply(r.replace(/\[.*?\]/g,'').substring(0,1900)); return; }

      // ── romera ──
      if(cmd==='romera'){
        const d=await getTodayCounts(CW_ROOM);
        let msg='**今日のメッセージ数ランキング**\n';
        if(!d.rows.length){ msg+='今日のメッセージはまだないみたい。'; }
        else{ for(let i=0;i<d.rows.length;i++){ const n=await CW.nameById(d.rows[i].accountId,[],CW_ROOM); msg+=`${i+1}位：${n} ${d.rows[i].count}コメ\n`; } }
        msg+=`\n合計：${d.rows.reduce((s,r)=>s+r.count,0)}コメ（ぼく込み）`;
        await interaction.editReply(msg.substring(0,1900)); return;
      }

      // ── message_total ──
      if(cmd==='message_total'){
        const r=await dbQuery('SELECT account_id,message_count FROM total_message_counts WHERE room_id=$1 ORDER BY message_count DESC',[CW_ROOM]);
        if(!r.rows.length){ await interaction.editReply('累計発言数はまだないみたい'); return; }
        let msg='**累計発言数ランキング**\n';
        for(let i=0;i<r.rows.length;i++){ const n=await CW.nameById(r.rows[i].account_id,[],CW_ROOM); msg+=`${i+1}位：${n} ${r.rows[i].message_count}コメ\n`; }
        await interaction.editReply(msg.substring(0,1900)); return;
      }

      // ── alarm ──
      if(cmd==='alarm'){
        const dt=interaction.options.getString('datetime'); const msg=interaction.options.getString('message');
        const mx=dt.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})$/);
        if(!mx){ await interaction.editReply('日時の形式がおかしいよ！例: `2026-04-10 15:30`'); return; }
        const t=new Date(`${mx[1]}T${mx[2]}:00+09:00`);
        await dbQuery('INSERT INTO alarms (room_id,discord_channel_id,scheduled_time,message,created_by) VALUES ($1,$2,$3,$4,$5)',[0,interaction.channelId,t,msg,0]);
        await interaction.editReply(`⏰ アラームを設定したよ！\n**${t.toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}** に「${msg}」を送信するね`); return;
      }

      // ── miaq ──
      if(cmd==='miaq'){
        try{
          const tm=await interaction.channel.messages.fetch(interaction.options.getString('message_id'));
          if(!tm){ await interaction.editReply('メッセージが見つからなかったよ'); return; }
          const r=await axios.post('https://makeit-a66a.onrender.com/',{text:tm.content||'',name:tm.member?.displayName||tm.author.username,id:tm.author.id},{headers:{'Content-Type':'application/json'},responseType:'arraybuffer',timeout:20000});
          await interaction.editReply({files:[new AttachmentBuilder(Buffer.from(r.data),{name:'quote.png'})]});
        } catch(e){ await interaction.editReply(`エラーが発生したよ: ${e.message}`); }
        return;
      }

      // ── room_info ──
      if(cmd==='room_info'){
        if(!INFO_API_TOKEN){ await interaction.editReply('INFO_API_TOKENが設定されていないよ'); return; }
        const rid=interaction.options.getString('room_id');
        const ri=await CW.roomInfoWithToken(rid,INFO_API_TOKEN);
        if(ri.error){ await interaction.editReply(ri.error==='not_found'?'そのルームは見つからなかったよ':'ルーム情報の取得に失敗しちゃった'); return; }
        const ms=await CW.membersWithToken(rid,INFO_API_TOKEN);
        if(!ms.some(m=>String(m.account_id)===YUYUYU_ACCOUNT_ID)){ await interaction.editReply('ますたーが参加していないルームだよ'); return; }
        const ip=ri.icon_path||''; const il=ip?(ip.startsWith('http')?ip:`https://appdata.chatwork.com${ip}`):'なし';
        await interaction.editReply(`**${ri.name}の情報**\nメンバー数：${ms.length}人\n管理者数：${ms.filter(m=>m.role==='admin').length}人\nルームID：${rid}\nファイル数：${ri.file_num||0}\nメッセージ数：${ri.message_num||0}\nアイコン：${il}\n管理者：${ms.filter(m=>m.role==='admin').map(m=>m.name).join(', ')||'なし'}`); return;
      }

      // ━━ 以下、管理者専用 ━━

      // ── clear ──
      if(cmd==='clear'){
        if(!isAdmin){ await interaction.editReply('管理者しか実行できないコマンドだよ！'); return; }
        const cnt=interaction.options.getInteger('count');
        const fetched=await interaction.channel.messages.fetch({limit:cnt});
        const del=fetched.filter(m=>(Date.now()-m.createdTimestamp)<14*24*60*60*1000);
        if(!del.size){ await interaction.editReply('削除できるメッセージがないよ（14日以上前は削除不可）'); return; }
        await interaction.channel.bulkDelete(del,true);
        await interaction.editReply(`${del.size}件のメッセージを削除したよ！`); return;
      }

      // ── prohibit ──
      if(cmd==='prohibit'){
        if(!isAdmin){ await interaction.editReply('管理者しか実行できないコマンドだよ！'); return; }
        const a=interaction.options.getString('duration'); const mm=a.match(/^(\d+)m$/),hm=a.match(/^(\d+)h$/);
        let s=mm?parseInt(mm[1])*60:hm?parseInt(hm[1])*3600:0;
        if(s<=0||s>10800){ await interaction.editReply('時間の指定がおかしいよ！5分なら `5m`、3時間なら `3h`（最大3時間）'); return; }
        const ea=new Date(Date.now()+s*1000);
        await dbQuery('INSERT INTO discord_prohibit (channel_id,ends_at) VALUES ($1,$2) ON CONFLICT (channel_id) DO UPDATE SET ends_at=$2',[interaction.channelId,ea]);
        await interaction.editReply(`発言禁止：**${ea.toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}** まで、このチャンネルで発言禁止にしたよ！`); return;
      }

      // ── release ──
      if(cmd==='release'){
        if(!isAdmin){ await interaction.editReply('管理者しか実行できないコマンドだよ！'); return; }
        await dbQuery('DELETE FROM discord_prohibit WHERE channel_id=$1',[interaction.channelId]);
        await interaction.editReply('このチャンネルの発言禁止を解除したよ！'); return;
      }

      // ── ban ──
      if(cmd==='ban'){
        if(!isAdmin){ await interaction.editReply('管理者しか実行できないコマンドだよ！'); return; }
        const cwId=interaction.options.getString('cw_account_id');
        await CW.addBlackList(CW_ROOM,cwId);
        const ms=await CW.members(CW_ROOM);
        const tgt=ms.find(m=>String(m.account_id)===cwId);
        if(tgt){ await CW.forceReadOnly(CW_ROOM,cwId,ms); }
        const name=await CW.nameById(cwId,[],CW_ROOM);
        await interaction.editReply(`${name}（${cwId}）をCWブラックリストに追加して閲覧のみにしたよ`); return;
      }

      // ── unban ──
      if(cmd==='unban'){
        if(!isAdmin){ await interaction.editReply('管理者しか実行できないコマンドだよ！'); return; }
        const cwId=interaction.options.getString('cw_account_id');
        await dbQuery('DELETE FROM black_list WHERE room_id=$1 AND account_id=$2',[CW_ROOM,cwId]);
        const name=await CW.nameById(cwId,[],CW_ROOM);
        await interaction.editReply(`${name}（${cwId}）をCWブラックリストから削除したよ`); return;
      }

      // ── blacklist ──
      if(cmd==='blacklist'){
        if(!isAdmin){ await interaction.editReply('管理者しか実行できないコマンドだよ！'); return; }
        const r=await dbQuery('SELECT account_id FROM black_list WHERE room_id=$1 ORDER BY account_id',[CW_ROOM]);
        if(!r.rows.length){ await interaction.editReply('CWブラックリストは空だよ'); return; }
        let msg='**CWブラックリスト**\n';
        for(const row of r.rows){ const n=await CW.nameById(row.account_id,[],CW_ROOM); msg+=`・${n}（${row.account_id}）\n`; }
        await interaction.editReply(msg.substring(0,1900)); return;
      }

      // ── kick ──
      if(cmd==='kick'){
        if(!isAdmin){ await interaction.editReply('管理者しか実行できないコマンドだよ！'); return; }
        const cwId=interaction.options.getString('cw_account_id');
        const ms=await CW.members(CW_ROOM); const tgt=ms.find(m=>String(m.account_id)===cwId);
        if(!tgt){ await interaction.editReply('そのIDのメンバーはCWルームにいないみたい'); return; }
        const ad=ms.filter(m=>m.role==='admin'&&String(m.account_id)!==cwId).map(m=>String(m.account_id));
        if(!ad.length){ await interaction.editReply('管理者が0人になるからキックできないよ'); return; }
        const me=ms.filter(m=>m.role==='member'&&String(m.account_id)!==cwId).map(m=>String(m.account_id));
        const ro=ms.filter(m=>m.role==='readonly'&&String(m.account_id)!==cwId).map(m=>String(m.account_id));
        const p=new URLSearchParams(); if(ad.length) p.append('members_admin_ids',ad.join(',')); if(me.length) p.append('members_member_ids',me.join(',')); if(ro.length) p.append('members_readonly_ids',ro.join(','));
        await apiCallLimiter(); await axios.put(`https://api.chatwork.com/v2/rooms/${CW_ROOM}/members`,p,{headers:{'X-ChatWorkToken':CHATWORK_API_TOKEN}});
        await interaction.editReply(`${tgt.name}（${cwId}）をCWルームからキックしたよっ！`); return;
      }

      // ── mute ──
      if(cmd==='mute'){
        if(!isAdmin){ await interaction.editReply('管理者しか実行できないコマンドだよ！'); return; }
        const cwId=interaction.options.getString('cw_account_id');
        const ms=await CW.members(CW_ROOM); const tgt=ms.find(m=>String(m.account_id)===cwId);
        if(!tgt){ await interaction.editReply('そのIDのメンバーはCWルームにいないみたい'); return; }
        if(tgt.role==='readonly'){ await interaction.editReply(`${tgt.name}はもう閲覧のみだよ`); return; }
        await CW.addBlackList(CW_ROOM,cwId); await CW.forceReadOnly(CW_ROOM,cwId,ms);
        await interaction.editReply(`${tgt.name}（${cwId}）をCWルームで閲覧のみにしたよっ！`); return;
      }

      // ── fever ──
      if(cmd==='fever'){
        if(!isAdmin){ await interaction.editReply('管理者しか実行できないコマンドだよ！'); return; }
        const a=interaction.options.getString('duration'); const mm=a.match(/^(\d+)m$/),hm=a.match(/^(\d+)h$/);
        let s=mm?parseInt(mm[1])*60:hm?parseInt(hm[1])*3600:0;
        if(s<=0||s>10800){ await interaction.editReply('時間の指定がおかしいよ！5分なら `5m`、3時間なら `3h`（最大3時間）'); return; }
        const ea=new Date(Date.now()+s*1000);
        await dbQuery(`INSERT INTO fever (room_id,ends_at) VALUES ($1,$2) ON CONFLICT (room_id) DO UPDATE SET ends_at=$2`,[CW_ROOM,ea]);
        await interaction.editReply(`CWフィーバータイム開始！**${ea.toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}** まで獲得ポイント10倍だよっ！`); return;
      }

      // ── ng_add ──
      if(cmd==='ng_add'){
        if(!isAdmin){ await interaction.editReply('管理者しか実行できないコマンドだよ！'); return; }
        const w=interaction.options.getString('word');
        await dbQuery('INSERT INTO ng_words (room_id,word) VALUES ($1,$2) ON CONFLICT DO NOTHING',[CW_ROOM,w]);
        await interaction.editReply(`「${w}」をCW NGワードに登録したよ！`); return;
      }

      // ── ng_del ──
      if(cmd==='ng_del'){
        if(!isAdmin){ await interaction.editReply('管理者しか実行できないコマンドだよ！'); return; }
        const w=interaction.options.getString('word');
        await dbQuery('DELETE FROM ng_words WHERE room_id=$1 AND word=$2',[CW_ROOM,w]);
        await interaction.editReply(`「${w}」をCW NGワードから削除したよ！`); return;
      }

      // ── ng_check ──
      if(cmd==='ng_check'){
        if(!isAdmin){ await interaction.editReply('管理者しか実行できないコマンドだよ！'); return; }
        const r=await dbQuery('SELECT word FROM ng_words WHERE room_id=$1 ORDER BY created_at',[CW_ROOM]);
        if(!r.rows.length){ await interaction.editReply('CW NGワードはまだ登録されてないよ'); return; }
        await interaction.editReply(`**CW NGワード一覧**\n${r.rows.map(x=>`・${x.word}`).join('\n')}`); return;
      }

      await interaction.editReply('不明なコマンドだよ');
    } catch(e){
      console.error('[Discord] コマンドエラー:',e.message);
      try{ if(!interaction.replied&&!interaction.deferred) await interaction.reply('エラーが発生したよ'); else await interaction.editReply('エラーが発生したよ'); } catch{}
    }
  });

  // Discord → Chatwork転送 + 投稿規制 + メッセージ反応
  discordClient.on(Events.MessageCreate, async(message)=>{
    try{
      // 自分自身（このbot）のメッセージは全てスキップ
      if(message.author.id === DISCORD_BOT_USER_ID) return;
      if(message.author.id === discordClient.user?.id) return;

      const content = message.content || '';
      if(!content) return;

      const isDM = !message.guild;
      const isAdmin = isDM ? false : (message.member?.permissions?.has(PermissionFlagsBits.ManageMessages)||false);
      const trimmed = content.trim();

      // ━━ 全チャンネル・DM共通のメッセージ反応（全ユーザー対象） ━━
      if(trimmed === 'おみくじ'){
        await message.reply(`おみくじの結果は…\n**${CW.drawOmikuji()}**\nだよっ！`).catch(()=>{});
      }
      {
        const m = trimmed.match(/^おみくじ(\d+)連$/);
        if(m){
          const n = Math.min(parseInt(m[1]), 10000);
          if(n >= 1){
            const rs = Array.from({length:n}, ()=>CW.drawOmikuji());
            await message.reply(`おみくじ${n}連（大凶99%版）の結果は…\n**${CW.summarizeOmikuji(rs)}**\nだよっ！`).catch(()=>{});
          }
        }
      }
      if(trimmed === 'おやすみ') await message.reply('おやすみ！').catch(()=>{});
      if(trimmed === 'おはよう') await message.reply('おはよう！').catch(()=>{});
      if(trimmed === 'ゆゆゆ'){
        const yid = process.env.YUYUYU_DISCORD_ID || '';
        const mention = yid ? `<@${yid}>` : '@shiratama_kotone';
        await message.reply(`${mention} ゆゆゆ\n${message.author.username}に呼ばれてるよっ！`).catch(()=>{});
      }

      // ━━ サーバー内のみ: 投稿規制チェック（botは除外） ━━
      if(!isDM && !isAdmin && !message.author.bot){
        const pr = await dbQuery('SELECT ends_at FROM discord_prohibit WHERE channel_id=$1 AND ends_at>NOW()',[message.channel.id]);
        if(pr.rowCount > 0){
          await message.delete().catch(()=>{});
          const w = await message.channel.send(`<@${message.author.id}> 現在このチャンネルは発言禁止中だよ！`).catch(()=>null);
          if(w) setTimeout(()=>w.delete().catch(()=>{}), 5000);
          return;
        }
      }

      // ━━ Chatwork連携チャンネルのみ: CW転送（全ユーザー・全bot対象） ━━
      if(!isDM && message.channel.id === DISCORD_BRIDGE_CHANNEL_ID){
        // 自分のwebhookが送ったメッセージはスキップ（ループ防止）
        // webhookId が一致する場合は無条件でスキップ
        if(DISCORD_WEBHOOK_ID && message.webhookId === DISCORD_WEBHOOK_ID) return;
        // IDベースのフォールバック（念のため）
        if(discordWebhookMsgIds.has(message.id)){ discordWebhookMsgIds.delete(message.id); return; }

        // 日付変更通知メッセージ（sendDailyGreetingが送るもの）はCW転送しない
        if(trimmed.startsWith('日付変更！')) return;

        const name = message.author.bot
          ? (message.author.username || 'Bot')
          : (message.member?.displayName || message.author.username);

        // Discord→CW: 「名前：内容」形式
        const cwMsg = `${name}：${content}`;

        const cwId = await CW.send(DISCORD_BRIDGE_CW_ROOM_ID, cwMsg);
        if(cwId && !message.author.bot){
          await dbQuery('INSERT INTO discord_bridge (cw_message_id,discord_message_id,cw_account_id) VALUES ($1,$2,$3)',
            [String(cwId), message.id, '0']).catch(()=>{});
        }
      }
    } catch(e){ console.error('[Discord] MessageCreate エラー:',e.message); }
  });

  discordClient.login(DISCORD_BOT_TOKEN).catch(e=>console.error('[Discord] ログインエラー:',e.message));
}

// ============================================================
// サーバー起動
// ============================================================
app.listen(port, async()=>{
  console.log(`\n=== 湊音BOT 起動中 (ポート${port}) ===`);
  console.log('CHATWORK_API_TOKEN:', CHATWORK_API_TOKEN?'設定済':'未設定');
  console.log('DISCORD_BOT_TOKEN:', DISCORD_BOT_TOKEN?'設定済':'未設定');
  console.log('DISCORD_WEBHOOK_URL:', DISCORD_WEBHOOK_URL?'設定済':'未設定');
  console.log('DB_URL (raw):', RAW_DB_URL?'設定済':'未設定');
  const cs=buildConnectionString(RAW_DB_URL);
  console.log('DB_URL (変換後):', cs?cs.replace(/:[^@]+@/,':***@'):'未設定');

  const dbOk=await checkDbConnection();
  console.log('DB接続:', dbOk?'成功':'失敗');
  if(dbOk){
    await initializeDatabase();
    // 起動時にChatwork名前を正常に戻す
    try{
      const p=new URLSearchParams(); p.append('name',BOT_NORMAL_NAME); if(BOT_NORMAL_ORG) p.append('organization_name',BOT_NORMAL_ORG);
      await axios.put('https://api.chatwork.com/v2/me',p,{headers:{'X-ChatWorkToken':CHATWORK_API_TOKEN}});
      console.log(`[CW] 名前を「${BOT_NORMAL_NAME}」に設定したよ`);
    } catch(e){ console.error('[CW] 起動時名前設定失敗:',e.message); }
  } else {
    // DB失敗 → 名前変更
    try{
      const p=new URLSearchParams(); p.append('name','白玉 湊音(DB接続失敗)'); p.append('organization_name','');
      await axios.put('https://api.chatwork.com/v2/me',p,{headers:{'X-ChatWorkToken':CHATWORK_API_TOKEN}});
    } catch(e){ console.error('[CW] 起動時DB失敗名前設定失敗:',e.message); }
  }

  // メッセージカウント初期化
  for(const r of DIRECT_CHAT_WITH_DATE_CHANGE){
    try{
      const msgs=await CW.getRoomMessages(r);
      const jst=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));
      const ts=Math.floor(new Date(jst.getFullYear(),jst.getMonth(),jst.getDate()).getTime()/1000);
      const counts={}; msgs.forEach(m=>{ if(m.send_time>=ts){ const id=m.account.account_id; counts[id]=(counts[id]||0)+1; } });
      mem.messageCounts.set(r,counts); mem.roomResetDates.set(r,jst.toISOString().split('T')[0]);
    } catch{}
    await new Promise(r=>setTimeout(r,1000));
  }

  // 起動通知
  for(const r of DIRECT_CHAT_WITH_DATE_CHANGE) await CW.send(r,'湊音が起動したよっ！').catch(()=>{});

  console.log('=== 起動完了！ ===\n');
});
