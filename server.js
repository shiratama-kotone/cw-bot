// Chatwork Bot for Render (WebHook版 - 全ルーム対応)
// server.js - 完全版（天気予報機能付き）

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { Pool } = require('pg');
const cheerio = require('cheerio');
const { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder, AttachmentBuilder, PermissionFlagsBits } = require('discord.js');

const app = express();
const port = process.env.PORT || 3000;

// ============================================================
// PostgreSQL/Supabase接続設定
// ============================================================
const DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '';
let pool = null;
let dbAvailable = false;

function createPool() {
  if (!DB_URL) return null;

  let connectionString = DB_URL;

  // Supabase の直接接続URL (db.xxx.supabase.co:5432) を
  // Transaction mode pooler (aws-0-xxx.pooler.supabase.com:6543) に変換
  // ※ Render は IPv4 のみのため IPv6 の直接接続は失敗する
  const supabaseMatch = DB_URL.match(
    /postgresql:\/\/([^:]+):([^@]+)@db\.([^.]+)\.supabase\.co:5432\/postgres/
  );
  if (supabaseMatch) {
    const user = supabaseMatch[1];
    const pass = supabaseMatch[2];
    const projectRef = supabaseMatch[3];
    // postgres.{ref} 形式のユーザー名が必要
    const poolUser = user.startsWith('postgres.') ? user : `postgres.${projectRef}`;
    connectionString = `postgresql://${poolUser}:${pass}@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres`;
    console.log('Supabase Transaction modeプーラーに切り替え:', connectionString.replace(/:[^@]+@/, ':***@'));
  }

  return new Pool({
    connectionString,
    ssl: {
      rejectUnauthorized: false,   // Supabase は自己署名証明書を使う場合がある
    },
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    max: 5,                        // Supabase free plan は同時接続数が少ない
  });
}

pool = createPool();

// DB操作のラッパー（失敗しても例外を投げずにオブジェクトを返す）
async function dbQuery(text, params = []) {
  if (!pool) return { rows: [], rowCount: 0 };
  try {
    const result = await pool.query(text, params);
    if (!dbAvailable) {
      dbAvailable = true;
      console.log('DB接続が回復したよ');
      await setBotChatworkName(BOT_NORMAL_NAME, BOT_NORMAL_ORG);
    }
    return result;
  } catch (e) {
    if (dbAvailable) {
      dbAvailable = false;
      console.error('DB接続エラー:', e.message);
      await setBotChatworkName('白玉 湊音(DB接続失敗)', '');
    }
    return { rows: [], rowCount: 0 };
  }
}

async function checkDbConnection() {
  if (!pool) {
    console.error('DB: poolが作成されてないよ（DB_URLが未設定かも）');
    return false;
  }
  try {
    await pool.query('SELECT 1');
    dbAvailable = true;
    return true;
  } catch (e) {
    dbAvailable = false;
    console.error('DB接続エラー詳細:', e.message);
    return false;
  }
}

const BOT_NORMAL_NAME = process.env.BOT_NAME || '白玉 湊音';
const BOT_NORMAL_ORG  = process.env.BOT_ORG  || '';

async function setBotChatworkName(name, org) {
  try {
    const params = new URLSearchParams();
    params.append('name', name);
    if (org !== undefined) params.append('organization_name', org);
    await axios.put('https://api.chatwork.com/v2/me', params, {
      headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
    });
    console.log(`Chatwork名前変更: ${name}`);
  } catch (e) {
    console.error('Chatwork名前変更エラー:', e.message);
  }
}

// ============================================================
// データベース初期化
// ============================================================
async function initializeDatabase() {
  if (!pool) { console.warn('DB未設定のためスキップ'); return; }
  const ok = await checkDbConnection();
  if (!ok) { console.warn('DB接続失敗のためテーブル初期化をスキップ'); return; }
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id SERIAL PRIMARY KEY,
        room_id BIGINT NOT NULL,
        message_id BIGINT NOT NULL,
        account_id BIGINT NOT NULL,
        account_name TEXT,
        body TEXT,
        send_time BIGINT NOT NULL,
        update_time BIGINT,
        webhook_event_type TEXT,
        webhook_event_time BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(message_id)
      )
    `);
    await dbQuery(`CREATE INDEX IF NOT EXISTS idx_webhooks_room_id ON webhooks(room_id)`);
    await dbQuery(`CREATE INDEX IF NOT EXISTS idx_webhooks_send_time ON webhooks(send_time)`);
    await dbQuery(`CREATE INDEX IF NOT EXISTS idx_webhooks_room_send ON webhooks(room_id, send_time)`);

    await dbQuery(`
      CREATE TABLE IF NOT EXISTS message_logs (
        id SERIAL PRIMARY KEY,
        room_id BIGINT NOT NULL,
        account_id BIGINT NOT NULL,
        message_body TEXT,
        send_time BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbQuery(`CREATE INDEX IF NOT EXISTS idx_message_logs_created ON message_logs(created_at)`);
    await dbQuery(`CREATE INDEX IF NOT EXISTS idx_message_logs_room ON message_logs(room_id)`);

    await dbQuery(`
      CREATE TABLE IF NOT EXISTS jirai_toggles (
        id SERIAL PRIMARY KEY,
        toggle_name VARCHAR(50) UNIQUE NOT NULL,
        is_enabled BOOLEAN DEFAULT FALSE,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    for (const toggle of ['gakusei', 'nyanko_a', 'milk', 'admin', 'yuyuyu']) {
      await dbQuery(
        'INSERT INTO jirai_toggles (toggle_name, is_enabled) VALUES ($1, $2) ON CONFLICT (toggle_name) DO NOTHING',
        [toggle, false]
      );
    }

    await dbQuery(`
      CREATE TABLE IF NOT EXISTS alarms (
        id SERIAL PRIMARY KEY,
        room_id BIGINT NOT NULL,
        discord_channel_id TEXT,
        scheduled_time TIMESTAMP NOT NULL,
        message TEXT NOT NULL,
        created_by BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbQuery(`ALTER TABLE alarms ADD COLUMN IF NOT EXISTS discord_channel_id TEXT`);
    await dbQuery(`CREATE INDEX IF NOT EXISTS idx_alarms_scheduled ON alarms(scheduled_time)`);

    await dbQuery(`
      CREATE TABLE IF NOT EXISTS total_message_counts (
        id SERIAL PRIMARY KEY,
        room_id BIGINT NOT NULL,
        account_id BIGINT NOT NULL,
        message_count BIGINT DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(room_id, account_id)
      )
    `);

    await dbQuery(`
      CREATE TABLE IF NOT EXISTS black_list (
        id SERIAL PRIMARY KEY,
        room_id BIGINT NOT NULL,
        account_id BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(room_id, account_id)
      )
    `);
    await dbQuery(`CREATE INDEX IF NOT EXISTS idx_black_list_room_account ON black_list(room_id, account_id)`);

    await dbQuery(`
      CREATE TABLE IF NOT EXISTS points (
        id SERIAL PRIMARY KEY,
        room_id BIGINT NOT NULL,
        account_id BIGINT NOT NULL,
        point BIGINT DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(room_id, account_id)
      )
    `);
    await dbQuery(`CREATE INDEX IF NOT EXISTS idx_points_room_account ON points(room_id, account_id)`);

    await dbQuery(`
      CREATE TABLE IF NOT EXISTS fever (
        id SERIAL PRIMARY KEY,
        room_id BIGINT NOT NULL UNIQUE,
        ends_at TIMESTAMP NOT NULL
      )
    `);

    // ★ Discord投稿規制テーブル（チャンネル単位）
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS discord_prohibit (
        id SERIAL PRIMARY KEY,
        channel_id TEXT NOT NULL UNIQUE,
        ends_at TIMESTAMP NOT NULL
      )
    `);

    await dbQuery(`
      CREATE TABLE IF NOT EXISTS ng_words (
        id SERIAL PRIMARY KEY,
        room_id BIGINT NOT NULL,
        word TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(room_id, word)
      )
    `);

    await dbQuery(`
      CREATE TABLE IF NOT EXISTS discord_bridge (
        id SERIAL PRIMARY KEY,
        cw_message_id TEXT,
        discord_message_id TEXT,
        cw_account_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbQuery(`ALTER TABLE discord_bridge ADD COLUMN IF NOT EXISTS cw_account_id TEXT`);

    console.log('データベーステーブル初期化完了');
  } catch (error) {
    console.error('データベース初期化エラー:', error.message);
  }
}

// ============================================================
// 地雷トグル
// ============================================================
async function loadJiraiToggles() {
  try {
    const result = await dbQuery('SELECT toggle_name, is_enabled FROM jirai_toggles');
    const toggles = {};
    result.rows.forEach(row => { toggles[row.toggle_name] = row.is_enabled; });
    return toggles;
  } catch (error) {
    return { gakusei: false, nyanko_a: false, milk: false, admin: false, yuyuyu: false };
  }
}

async function saveJiraiToggle(toggleName, isEnabled) {
  try {
    await dbQuery(
      'UPDATE jirai_toggles SET is_enabled = $1, updated_at = NOW() WHERE toggle_name = $2',
      [isEnabled, toggleName]
    );
  } catch (error) {
    console.error('地雷トグル保存エラー:', error.message);
  }
}

// ============================================================
// 環境変数
// ============================================================
const CHATWORK_API_TOKEN = process.env.CHATWORK_API_TOKEN || '';
const INFO_API_TOKEN = process.env.INFO_API_TOKEN || '';
const DIRECT_CHAT_WITH_DATE_CHANGE = (process.env.DIRECT_CHAT_WITH_DATE_CHANGE || '405497983,407676893,415060980,406897783,391699365').split(',');
const LOG_ROOM_ID = '415060980';
const LOG_DESTINATION_ROOM_ID = '420890621';
const DAY_JSON_URL = process.env.DAY_JSON_URL || 'https://raw.githubusercontent.com/shiratama-kotone/cw-bot/main/day.json';
const YUYUYU_ACCOUNT_ID = '10544705';
const BOT_ACCOUNT_ID = '10386947';

// Discord設定
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const DISCORD_BRIDGE_CW_ROOM_ID = '415060980';
const DISCORD_BRIDGE_CHANNEL_ID = '1371130293888745554';         // Chatwork連携チャンネル
const DISCORD_DATE_CHANGE_CHANNEL_ID = '1501947796742344704';    // ★ 日付変更通知チャンネル

// 天気予報の地域設定
const WEATHER_AREAS = [
  { name: 'さぽろー', code: '016010' },
  { name: 'おさかー', code: '270000' },
  { name: 'なごやー', code: '230010' },
  { name: 'ふくおかー', code: '400010' },
  { name: 'なはー', code: '471010' }
];

// ============================================================
// メモリストレージ
// ============================================================
const memoryStorage = {
  properties: new Map(),
  lastSentDates: new Map(),
  messageCounts: new Map(),
  roomResetDates: new Map(),
  lastEarthquakeId: null,
  lastNhkNewsId: null,
  sentWarnings: new Map(),
  toggles: { gakusei: false, nyanko_a: false, milk: false, admin: false, yuyuyu: false }
};

// ============================================================
// Chatwork APIレートリミット
// ============================================================
const MAX_API_CALLS_PER_10SEC = 10;
const API_WINDOW_MS = 10000;
let apiCallTimestamps = [];

async function apiCallLimiter() {
  const now = Date.now();
  apiCallTimestamps = apiCallTimestamps.filter(ts => now - ts < API_WINDOW_MS);
  if (apiCallTimestamps.length >= MAX_API_CALLS_PER_10SEC) {
    const waitMs = API_WINDOW_MS - (now - apiCallTimestamps[0]) + 50;
    await new Promise(res => setTimeout(res, waitMs));
  }
  apiCallTimestamps.push(Date.now());
}

// ============================================================
// Chatwork絵文字
// ============================================================
const CHATWORK_EMOJI_NO_PAREN = [
  ':)', ':(', ':D', '8-)', ':o', ';)', ';(', ':|', ':*', ':p',
  ':^)', '|-)', ']:)', '8-|', ':#)', ':/'
];
const CHATWORK_EMOJI_WITH_PAREN = [
  'sweat', 'blush', 'inlove', 'talk', 'yawn', 'puke', 'emo',
  'nod', 'shake', '^^;', 'whew', 'clap', 'bow', 'roger', 'flex', 'dance',
  'gogo', 'think', 'please', 'quick', 'anger', 'devil', 'lightbulb',
  '*', 'h', 'F', 'cracker', 'eat', '^', 'coffee', 'beer', 'handshake', 'y', 'ec14'
];

function escapeRegex(s) { return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'); }
const _noParenPart = CHATWORK_EMOJI_NO_PAREN.map(escapeRegex).join('|');
const _withParenPart = CHATWORK_EMOJI_WITH_PAREN.map(escapeRegex).join('|');
const CHATWORK_EMOJI_REGEX = new RegExp(`(?:${_noParenPart})|\\((${_withParenPart})\\)`, 'g');

// APIキャッシュ
const API_CACHE = new Map();
const MAX_CACHE_SIZE = 50;
function addToCache(key, value) {
  if (API_CACHE.size >= MAX_CACHE_SIZE) API_CACHE.delete(API_CACHE.keys().next().value);
  API_CACHE.set(key, value);
}

// ============================================================
// day.json
// ============================================================
async function loadDayEvents() {
  try {
    const response = await axios.get(DAY_JSON_URL);
    return response.data;
  } catch (error) {
    console.error('day.json読み込みエラー:', error.message);
    return {};
  }
}

async function getTodaysEventsFromJson() {
  try {
    const dayEvents = await loadDayEvents();
    const now = new Date();
    const jstDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const monthDay = `${String(jstDate.getMonth() + 1).padStart(2, '0')}-${String(jstDate.getDate()).padStart(2, '0')}`;
    const events = [];
    if (dayEvents[monthDay]) {
      if (Array.isArray(dayEvents[monthDay])) events.push(...dayEvents[monthDay]);
      else events.push(dayEvents[monthDay]);
    }
    return events;
  } catch (error) {
    return [];
  }
}

// ============================================================
// ChatworkBotUtils
// ============================================================
class ChatworkBotUtils {
  static async getChatworkMembers(roomId) {
    await apiCallLimiter();
    try {
      const response = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}/members`, {
        headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
      });
      return response.data.map(m => ({ account_id: m.account_id, name: m.name, role: m.role }));
    } catch (error) {
      console.error(`メンバー取得エラー (${roomId}):`, error.message);
      return [];
    }
  }

  static async getRoomInfo(roomId) {
    await apiCallLimiter();
    try {
      const response = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}`, {
        headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
      });
      return response.data;
    } catch (error) {
      console.error(`ルーム情報取得エラー (${roomId}):`, error.message);
      return null;
    }
  }

  static async sendChatworkMessage(roomId, message) {
    await apiCallLimiter();
    try {
      const response = await axios.post(
        `https://api.chatwork.com/v2/rooms/${roomId}/messages`,
        new URLSearchParams({ body: message }),
        { headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN } }
      );
      return response.data.message_id;
    } catch (error) {
      console.error(`メッセージ送信エラー (${roomId}):`, error.message);
      return null;
    }
  }

  static async sendLogToChatwork(userName, messageBody, sourceRoomId) {
    try {
      if (sourceRoomId !== LOG_ROOM_ID) return;
      const logMessage = `[info][title]${userName}[/title]${messageBody}[/info]`;
      await this.sendChatworkMessage(LOG_DESTINATION_ROOM_ID, logMessage);
    } catch (error) {
      console.error('Chatworkログ送信エラー:', error.message);
    }
  }

  static countChatworkEmojis(text) {
    const cleaned = text
      .replace(/https?:\/\/[^\s\]）)]+/g, '')
      .replace(/\[info\][\s\S]*?\[\/info\]/g, '')
      .replace(/\[[^\]]+\]/g, '');
    const matches = cleaned.match(CHATWORK_EMOJI_REGEX);
    return matches ? matches.length : 0;
  }

  static drawOmikuji(isAdmin) {
    if (Math.random() < 0.002) return '湊音すぺしゃるっ！';
    const fortunes = [
      { name: '大吉', weight: 0.01 }, { name: '中吉', weight: 0.02 },
      { name: '吉', weight: 0.02 },   { name: '小吉', weight: 0.2 },
      { name: '末吉', weight: 0.2 },  { name: '凶', weight: 0.5 },
      { name: '大凶', weight: 99.05 }
    ];
    const total = fortunes.reduce((s, f) => s + f.weight, 0);
    let rand = Math.random() * total;
    for (const f of fortunes) { if (rand < f.weight) return f.name; rand -= f.weight; }
    return '凶';
  }

  static async getYesOrNoAnswer() {
    try {
      const response = await axios.get('https://yesno.wtf/api');
      return response.data.answer || 'no';
    } catch { return Math.random() < 0.5 ? 'yes' : 'no'; }
  }

  static async getJiraiProbability(accountId, isSenderAdmin) {
    let probability = 0.0005;
    const toggles = await loadJiraiToggles();
    const id = String(accountId);
    if (toggles.gakusei && id === '9553691')  probability = Math.max(probability, 0.25);
    if (toggles.nyanko_a && id === '9487124') probability = Math.max(probability, 1.0);
    if (toggles.milk && id === '11092754')    probability = Math.max(probability, 0.50);
    if (toggles.admin && isSenderAdmin)       probability = Math.max(probability, 0.25);
    if (toggles.yuyuyu && id === '10911090')  probability = Math.max(probability, 0.75);
    return probability;
  }

  static async getWikipediaSummary(searchTerm) {
    const now = Date.now();
    const cacheKey = `wiki_${searchTerm}`;
    if (API_CACHE.has(cacheKey)) {
      const c = API_CACHE.get(cacheKey);
      if (now - c.timestamp < 300000) return c.data;
    }
    try {
      const searchParams = new URLSearchParams({
        action: 'opensearch', format: 'json', search: searchTerm,
        limit: 1, namespace: 0, redirects: 'resolve'
      });
      const searchResponse = await axios.get(`https://ja.wikipedia.org/w/api.php?${searchParams}`, {
        timeout: 10000, headers: { 'User-Agent': 'ChatworkBot/1.0' }
      });
      const searchData = searchResponse.data;
      if (!searchData?.[1]?.length) {
        const result = `「${searchTerm}」に関する記事は見つからなかったよ`;
        addToCache(cacheKey, { data: result, timestamp: now });
        return result;
      }
      const pageTitle = searchData[1][0];
      const pageUrl = searchData[3][0];
      const extractParams = new URLSearchParams({
        action: 'query', format: 'json', prop: 'extracts',
        exintro: true, explaintext: true, titles: pageTitle, redirects: 1
      });
      const extractResponse = await axios.get(`https://ja.wikipedia.org/w/api.php?${extractParams}`, {
        timeout: 10000, headers: { 'User-Agent': 'ChatworkBot/1.0' }
      });
      const pages = extractResponse.data?.query?.pages;
      if (pages) {
        const pageId = Object.keys(pages)[0];
        if (pageId && pageId !== '-1' && pages[pageId]?.extract) {
          let summary = pages[pageId].extract;
          if (summary.length > 500) summary = summary.substring(0, 500) + '...';
          const result = `${summary}\n\n元記事は ${pageUrl} だよっ！`;
          addToCache(cacheKey, { data: result, timestamp: now });
          return result;
        }
      }
      const result = `「${searchTerm}」の情報を取得できなかったよ`;
      addToCache(cacheKey, { data: result, timestamp: now });
      return result;
    } catch (error) {
      return `Wikipedia検索中にエラーが発生したよ: ${error.message}`;
    }
  }

  static async getScratchUserStats(username) {
    try {
      const response = await axios.get(`https://api.scratch.mit.edu/users/${encodeURIComponent(username)}`);
      const data = response.data;
      const bio = data.profile?.bio ?? '';
      const status = data.profile?.status ?? '';
      const userLink = `https://scratch.mit.edu/users/${encodeURIComponent(username)}/`;
      let result = '';
      if (bio) result += `[info][title]私について[/title]${bio}[/info]\n\n`;
      if (status) result += `[info][title]私が取り組んでいること[/title]${status}[/info]\n\n`;
      if (!bio && !status) result = `[info][title]Scratchユーザー情報[/title]ユーザー名: ${username}\nプロフィール情報がないよっ！[/info]\n\n`;
      result += `ユーザーページ: ${userLink}`;
      return result;
    } catch (error) {
      if (error.response?.status === 404) return `「${username}」というScratchユーザーは見つからなかったよ`;
      return `Scratchユーザー情報の取得してるときに予期してなかったエラーが起こっちゃった。`;
    }
  }

  static async getScratchProjectInfo(projectId) {
    try {
      await apiCallLimiter();
      const response = await axios.get(`https://api.scratch.mit.edu/projects/${projectId}`);
      const data = response.data;
      if (!data?.title) return 'プロジェクトが見つからなかったよ';
      const url = `https://scratch.mit.edu/projects/${projectId}/`;
      return `[info][title]Scratchプロジェクト情報[/title]タイトル: ${data.title}\n作者: ${data.author.username}\n説明: ${data.description || '説明なし'}\nURL: ${url}[/info]`;
    } catch { return 'Scratchプロジェクト情報の取得中にエラーが発生したよ'; }
  }

  static async getLyrics(url) {
    try {
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3'
        }
      });
      const $ = cheerio.load(response.data);
      let title = '', lyrics = '';

      if (url.includes('utaten.com')) {
        title = $('h2.newLyricTitle__main').text().trim() || $('h1.lyricTitle').text().trim() || $('title').text().split('の歌詞')[0].trim();
        $('span.rt').remove(); $('rp').remove(); $('rt').remove();
        lyrics = ($('div.hiragana').first().html() || $('p.hiragana').first().html() || '');
        lyrics = lyrics.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
      } else if (url.includes('uta-net.com')) {
        title = $('h2.ms-2.ms-md-3.kashi-title').text().trim() || $('h1').first().text().trim();
        lyrics = $('div#kashi_area').first().html() || '';
        lyrics = lyrics.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
      } else if (url.includes('atwiki.jp')) {
        const songIntroH3 = $('h3:contains("曲紹介")');
        if (songIntroH3.length > 0) {
          let cur = songIntroH3.next();
          while (cur.length > 0 && !cur.is('h3')) {
            const m = cur.text().match(/曲名：[『「]?(.+?)[』」]?[（(]/);
            if (m) { title = m[1].trim(); break; }
            cur = cur.next();
          }
        }
        if (!title) { title = $('title').text().trim(); if (title.includes(' - ')) title = title.split(' - ')[0].trim(); }
        const lyricsStart = $('h3:contains("歌詞")');
        if (lyricsStart.length === 0) return '歌詞セクションが見つからなかったよ';
        let lyricsHtml = '';
        let cur2 = lyricsStart.next();
        while (cur2.length > 0) {
          if (cur2.is('h3') && cur2.text().includes('関連動画')) break;
          if (cur2.is('div') || cur2.is('br')) lyricsHtml += $.html(cur2);
          cur2 = cur2.next();
        }
        lyrics = lyricsHtml.replace(/<br\s*\/?>/gi, '\n').replace(/<div>/gi, '').replace(/<\/div>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
      } else {
        return '対応していないURLだよっ！utaten.com、uta-net.com、またはatwiki.jpのURLを指定してねっ！';
      }
      if (!lyrics) return '歌詞の取得に失敗しちゃった（歌詞が空）。URLを確認してくれるとうれしいな';
      if (!title) title = '不明';
      if (lyrics.length > 3500) lyrics = lyrics.substring(0, 3500) + '\n…（以下省略）';
      return `[info][title]${title}の歌詞だよっ！[/title]${lyrics}[/info]`;
    } catch (error) {
      return `歌詞の取得中にエラーが発生しちゃった: ${error.message}`;
    }
  }

  static async getSongTypingInfo(songId) {
    try {
      const response = await axios.get(
        'https://shiratama-kotone.github.io/typing-game/song-typing/lyrics-data.js',
        { timeout: 10000 }
      );
      const match = response.data.match(/(?:const|var|let)\s+lyricsData\s*=\s*(\[[\s\S]*\])\s*;/);
      if (!match) return '歌詞データの解析に失敗しちゃった';
      let lyricsData;
      try { lyricsData = (new Function(`return ${match[1]};`))(); } catch { return '歌詞データの解析に失敗しちゃった'; }
      const songs = lyricsData.filter(s => s.id === songId);
      if (songs.length === 0) return `曲ID「${songId}」が見つからなかったよ`;
      const results = [];
      for (const song of songs) {
        let totalCount = 0;
        song.lyrics.forEach(line => { totalCount += line.kana.length; });
        const lineCount = song.lyrics.length;
        let duration = '取得中...';
        try {
          const ytResponse = await axios.get(`https://www.youtube.com/watch?v=${song.youtubeId}`, { timeout: 5000 });
          const durationMatch = ytResponse.data.match(/"lengthSeconds":"(\d+)"/);
          if (durationMatch) {
            const seconds = parseInt(durationMatch[1]);
            duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
          }
        } catch { duration = '取得失敗'; }
        let avgSpeed = '計算中...';
        if (duration !== '取得中...' && duration !== '取得失敗') {
          const [min, sec] = duration.split(':').map(Number);
          avgSpeed = `${(totalCount / (min * 60 + sec)).toFixed(2)}打/秒`;
        }
        results.push(`[info][title]${song.title}の歌詞タイピング情報[/title]総打数：${totalCount}\n曲の長さ：${duration}\n必要平均タイプ速度：${avgSpeed}\nライン数：${lineCount}[/info]`);
      }
      return results.join('\n');
    } catch (error) {
      return `歌詞タイピング情報の取得中にエラーが発生しちゃった: ${error.message}`;
    }
  }

  static async getWeatherForecast(areaCode) {
    try {
      const response = await axios.get(`https://weather.tsukumijima.net/api/forecast/city/${areaCode}`, { timeout: 10000 });
      return response.data;
    } catch (error) {
      console.error(`天気予報取得エラー (${areaCode}):`, error.message);
      return null;
    }
  }

  static async initializeMessageCount(roomId) {
    try {
      const messages = await this.getRoomMessages(roomId);
      const now = new Date();
      const jstDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
      const todayStart = new Date(jstDate.getFullYear(), jstDate.getMonth(), jstDate.getDate(), 0, 0, 0);
      const todayStartTimestamp = Math.floor(todayStart.getTime() / 1000);
      const counts = {};
      messages.forEach(msg => {
        if (msg.send_time >= todayStartTimestamp) {
          const accId = msg.account.account_id;
          counts[accId] = (counts[accId] || 0) + 1;
        }
      });
      memoryStorage.messageCounts.set(roomId, counts);
      memoryStorage.roomResetDates.set(roomId, jstDate.toISOString().split('T')[0]);
      return counts;
    } catch (error) {
      return {};
    }
  }

  static async initializeTotalMessageCounts(roomId) {
    try {
      const dbResult = await dbQuery(
        `SELECT account_id, COUNT(*) as count FROM webhooks WHERE room_id = $1 AND webhook_event_type = $2 GROUP BY account_id`,
        [roomId, 'message_created']
      );
      const counts = {};
      if (dbResult?.rows) dbResult.rows.forEach(row => { counts[row.account_id] = parseInt(row.count); });
      for (const [accountId, count] of Object.entries(counts)) {
        await dbQuery(`
          INSERT INTO total_message_counts (room_id, account_id, message_count)
          VALUES ($1, $2, $3)
          ON CONFLICT (room_id, account_id)
          DO UPDATE SET message_count = GREATEST(total_message_counts.message_count, $3), updated_at = NOW()
        `, [roomId, accountId, count]);
      }
      return counts;
    } catch (error) {
      return {};
    }
  }

  static async getRoomMessages(roomId) {
    try {
      await apiCallLimiter();
      const response = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}/messages`, {
        headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN },
        params: { force: 1 }
      });
      return response.data || [];
    } catch (error) {
      return [];
    }
  }

  static async getMessage(roomId, messageId) {
    try {
      await apiCallLimiter();
      const response = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}/messages/${messageId}`, {
        headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
      });
      return response.data;
    } catch (error) {
      return null;
    }
  }

  static async deleteMessage(roomId, messageId) {
    await apiCallLimiter();
    try {
      await axios.delete(`https://api.chatwork.com/v2/rooms/${roomId}/messages/${messageId}`, {
        headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  static async getLatestEarthquakeInfo() {
    try {
      const response = await axios.get('https://api.p2pquake.net/v2/history?codes=551&limit=1');
      const data = response.data;
      if (!data?.length || !data[0].earthquake || data[0].earthquake.maxScale < 10) return null;
      const earthquake = data[0];
      const targetRegions = ['福岡', '北海道', '大阪'];
      let shouldNotify = false;
      if (earthquake.earthquake.maxScale >= 30) {
        shouldNotify = true;
      } else if (earthquake.earthquake.points?.some(p => p.scale >= 10 && targetRegions.some(r => (p.pref || '').includes(r) || (p.addr || '').includes(r)))) {
        shouldNotify = true;
      } else if (targetRegions.some(r => (earthquake.earthquake.hypocenter?.name || '').includes(r))) {
        shouldNotify = true;
      }
      if (!shouldNotify) return null;
      return {
        id: earthquake.id,
        time: earthquake.earthquake.time,
        hypocenter: earthquake.earthquake.hypocenter?.name || null,
        magnitude: earthquake.earthquake.hypocenter?.magnitude ?? null,
        maxScale: earthquake.earthquake.maxScale,
        points: earthquake.earthquake.points || []
      };
    } catch (error) {
      return null;
    }
  }

  static async notifyEarthquake(earthquakeInfo, isTest = false) {
    try {
      const scaleMap = { 10:'1', 20:'2', 30:'3', 40:'4', 45:'5弱', 50:'5強', 55:'6弱', 60:'6強', 70:'7' };
      const scale = scaleMap[earthquakeInfo.maxScale] || (earthquakeInfo.maxScale / 10);
      const d = new Date(earthquakeInfo.time);
      const title = isTest ? '地震情報-テストだよ' : '地震情報だよ';
      const magText = (earthquakeInfo.magnitude === null || earthquakeInfo.magnitude === -1) ? 'まだわかんない' : earthquakeInfo.magnitude;
      const place = earthquakeInfo.hypocenter && earthquakeInfo.hypocenter !== '不明' ? ` ${earthquakeInfo.hypocenter} で` : '';
      const message = `[info][title]${title}[/title]${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日 ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')} に${place}震度${scale}の地震が発生したよ。\nマグニチュードは${magText}\n引き続き情報に注意してね！[/info]`;
      for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
        await this.sendChatworkMessage(roomId, message).catch(() => {});
      }
    } catch (error) {
      console.error('地震情報通知エラー:', error.message);
    }
  }

  static async getRoomInfoWithToken(roomId, apiToken) {
    await apiCallLimiter();
    try {
      const response = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}`, {
        headers: { 'X-ChatWorkToken': apiToken }
      });
      return response.data;
    } catch (error) {
      if (error.response?.status === 404) return { error: 'not_found' };
      return { error: 'unknown' };
    }
  }

  static async getRoomMembersWithToken(roomId, apiToken) {
    await apiCallLimiter();
    try {
      const response = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}/members`, {
        headers: { 'X-ChatWorkToken': apiToken }
      });
      return response.data.map(m => ({ account_id: m.account_id, name: m.name, role: m.role }));
    } catch (error) {
      return [];
    }
  }

  static async isRoomMember(roomId) {
    try {
      await apiCallLimiter();
      await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}`, {
        headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
      });
      return true;
    } catch { return false; }
  }

  static async getNameById(targetAccountId, cachedMembers = [], roomId = null) {
    const found = cachedMembers.find(m => String(m.account_id) === String(targetAccountId));
    if (found) return found.name;
    if (roomId) {
      try {
        const members = await this.getChatworkMembers(roomId);
        const member = members.find(m => String(m.account_id) === String(targetAccountId));
        if (member) return member.name;
      } catch {}
    }
    try {
      await apiCallLimiter();
      const res = await axios.get('https://api.chatwork.com/v2/contacts', {
        headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
      });
      const contact = res.data.find(c => String(c.account_id) === String(targetAccountId));
      if (contact) return contact.name;
    } catch {}
    return String(targetAccountId);
  }

  static async addToBlackList(roomId, accountId) {
    try {
      await dbQuery(
        'INSERT INTO black_list (room_id, account_id) VALUES ($1, $2) ON CONFLICT (room_id, account_id) DO NOTHING',
        [roomId, accountId]
      );
    } catch (error) {
      console.error('ブラックリスト追加エラー:', error.message);
    }
  }

  static async isInBlackList(roomId, accountId) {
    try {
      const result = await dbQuery('SELECT 1 FROM black_list WHERE room_id = $1 AND account_id = $2', [roomId, accountId]);
      return result.rowCount > 0;
    } catch { return false; }
  }

  static async forceReadOnly(roomId, targetAccountId, currentMembers) {
    try {
      const admins   = currentMembers.filter(m => m.role === 'admin').map(m => String(m.account_id));
      const members  = currentMembers.filter(m => m.role === 'member' && String(m.account_id) !== String(targetAccountId)).map(m => String(m.account_id));
      const readonly = currentMembers.filter(m => m.role === 'readonly').map(m => String(m.account_id));
      if (!readonly.includes(String(targetAccountId))) readonly.push(String(targetAccountId));
      const params = new URLSearchParams();
      if (admins.length   > 0) params.append('members_admin_ids', admins.join(','));
      if (members.length  > 0) params.append('members_member_ids', members.join(','));
      if (readonly.length > 0) params.append('members_readonly_ids', readonly.join(','));
      await apiCallLimiter();
      await axios.put(`https://api.chatwork.com/v2/rooms/${roomId}/members`, params, {
        headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
      });
      return true;
    } catch (error) {
      console.error('ブラックリスト強制閲覧変更エラー:', error.message);
      return false;
    }
  }
}

// ============================================================
// WebHookメッセージ処理
// ============================================================
class WebHookMessageProcessor {
  static async saveWebhookToDatabase(webhookData) {
    try {
      await dbQuery(`
        INSERT INTO webhooks (room_id, message_id, account_id, account_name, body, send_time, update_time, webhook_event_type, webhook_event_time)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (message_id) DO NOTHING
      `, [
        webhookData.room_id, webhookData.message_id, webhookData.account_id,
        webhookData.account?.name || null, webhookData.body || '',
        webhookData.send_time, webhookData.update_time || null,
        webhookData.webhook_event_type || 'message_created',
        webhookData.webhook_event_time || null
      ]);
    } catch (error) {
      console.error('WebHook保存エラー:', error.message);
    }
  }

  static async saveMessageLog(webhookData) {
    try {
      if (String(webhookData.room_id) !== LOG_ROOM_ID || (webhookData.webhook_event_type || 'message_created') !== 'message_created') return;
      await dbQuery(
        'INSERT INTO message_logs (room_id, account_id, message_body, send_time) VALUES ($1, $2, $3, $4)',
        [webhookData.room_id, webhookData.account_id, webhookData.body || '', webhookData.send_time]
      );
    } catch (error) {
      console.error('メッセージログ保存エラー:', error.message);
    }
  }

  static async updateTotalMessageCount(roomId, accountId) {
    try {
      await dbQuery(`
        INSERT INTO total_message_counts (room_id, account_id, message_count)
        VALUES ($1, $2, 1)
        ON CONFLICT (room_id, account_id)
        DO UPDATE SET message_count = total_message_counts.message_count + 1, updated_at = NOW()
      `, [roomId, accountId]);
    } catch (error) {
      console.error('累計発言数更新エラー:', error.message);
    }
  }

  static async processWebHookMessage(webhookData) {
    try {
      await this.saveWebhookToDatabase(webhookData);
      await this.saveMessageLog(webhookData);

      const roomId = webhookData.room_id;
      const messageBody = webhookData.body;
      const messageId = webhookData.message_id;
      const accountId = webhookData.account_id;
      const account = webhookData.account || null;
      const eventType = webhookData.webhook_event_type || 'message_created';

      if (String(accountId) === BOT_ACCOUNT_ID) return;

      if (eventType === 'message_created') await this.updateTotalMessageCount(roomId, accountId);

      if (!roomId || !accountId || !messageBody) return;

      // NGワードチェック
      if (eventType === 'message_created') {
        const ngResult = await dbQuery('SELECT word FROM ng_words WHERE room_id = $1', [roomId]);
        if (ngResult.rowCount > 0) {
          const tempMembers = await ChatworkBotUtils.getChatworkMembers(roomId);
          const isAdm = WebHookMessageProcessor.isUserAdmin(accountId, tempMembers);
          if (!isAdm) {
            const hit = ngResult.rows.find(r => messageBody.includes(r.word));
            if (hit) {
              await ChatworkBotUtils.addToBlackList(roomId, accountId);
              await ChatworkBotUtils.forceReadOnly(roomId, accountId, tempMembers);
              const ngUserName = await ChatworkBotUtils.getNameById(accountId, tempMembers, roomId);
              await ChatworkBotUtils.sendChatworkMessage(roomId, `[picon:${accountId}]${ngUserName}ちゃんがNGワード「${hit.word}」を含むメッセージを送ったから閲覧のみにしたよ`);
            }
          }
        }
      }

      // ポイント付与
      if (eventType === 'message_created') {
        const PRIV_IDS = ['10911090', '9553691'];
        const tempMembers2 = await ChatworkBotUtils.getChatworkMembers(roomId).catch(() => []);
        const isAdm2 = WebHookMessageProcessor.isUserAdmin(accountId, tempMembers2);
        let basePoint = 1;
        if (PRIV_IDS.includes(String(accountId))) basePoint = 5;
        else if (isAdm2) basePoint = 2;
        const feverResult = await dbQuery('SELECT ends_at FROM fever WHERE room_id = $1 AND ends_at > NOW()', [roomId]);
        if (feverResult.rowCount > 0) basePoint *= 10;
        await dbQuery(`
          INSERT INTO points (room_id, account_id, point) VALUES ($1, $2, $3)
          ON CONFLICT (room_id, account_id) DO UPDATE SET point = points.point + $3, updated_at = NOW()
        `, [roomId, accountId, basePoint]);
      }

      // ウェルカムメッセージ & ブラックリスト再参加チェック
      if (messageBody.includes('[dtext:chatroom_member_is]') && messageBody.includes('[dtext:chatroom_added]')) {
        const piconnameMatch = messageBody.match(/\[piconname:(\d+)\]/);
        if (piconnameMatch?.[1]) {
          const newUserId = piconnameMatch[1];
          const isBlacklisted = await ChatworkBotUtils.isInBlackList(String(roomId), newUserId);
          if (isBlacklisted) {
            await new Promise(r => setTimeout(r, 1500));
            const freshMembers = await ChatworkBotUtils.getChatworkMembers(roomId);
            await ChatworkBotUtils.forceReadOnly(roomId, newUserId, freshMembers);
            const newUserName = await ChatworkBotUtils.getNameById(newUserId, freshMembers);
            await ChatworkBotUtils.sendChatworkMessage(roomId, `[To:${newUserId}][picon:${newUserId}]${newUserName}ちゃんはブラックリストに入ってるから閲覧のみにしたよ`);
          } else if (String(roomId) === LOG_ROOM_ID) {
            const freshMembers = await ChatworkBotUtils.getChatworkMembers(roomId);
            const newUserName = await ChatworkBotUtils.getNameById(newUserId, freshMembers);
            await new Promise(r => setTimeout(r, 1000));
            await ChatworkBotUtils.sendChatworkMessage(roomId, `[To:${newUserId}][picon:${newUserId}]${newUserName}ちゃん\nこの部屋へようこそ！\nこの部屋は色々とおかしいけどよろしくね！`);
          }
        }
      }

      // 権限変更でブラックリストチェック
      if (messageBody.includes('[dtext:chatroom_member_is]') && messageBody.includes('[dtext:chatroom_priv_changed]')) {
        const piconnameMatch = messageBody.match(/\[piconname:(\d+)\]/);
        if (piconnameMatch?.[1]) {
          const changedUserId = piconnameMatch[1];
          const isBlacklisted = await ChatworkBotUtils.isInBlackList(String(roomId), changedUserId);
          if (isBlacklisted) {
            await new Promise(r => setTimeout(r, 1500));
            const freshMembers = await ChatworkBotUtils.getChatworkMembers(roomId);
            const member = freshMembers.find(m => String(m.account_id) === String(changedUserId));
            if (member && member.role !== 'readonly') {
              await ChatworkBotUtils.forceReadOnly(roomId, changedUserId, freshMembers);
              const changedUserName = await ChatworkBotUtils.getNameById(changedUserId, freshMembers);
              await ChatworkBotUtils.sendChatworkMessage(roomId, `[picon:${changedUserId}]${changedUserName}ちゃんはブラックリストに入ってるから閲覧のみに戻したよ`);
            }
          }
        }
      }

      this.updateMessageCount(roomId, accountId);

      let currentMembers = [];
      let isSenderAdmin = true;
      const isDirectChat = webhookData.room_type === 'direct';
      if (!isDirectChat) {
        currentMembers = await ChatworkBotUtils.getChatworkMembers(roomId);
        isSenderAdmin = this.isUserAdmin(accountId, currentMembers);
      }

      let userName = account?.name || await ChatworkBotUtils.getNameById(accountId, currentMembers);

      await ChatworkBotUtils.sendLogToChatwork(userName, messageBody, roomId);

      // 転送処理
      if (roomId === '415060980' || roomId === 415060980) {
        const forwardRoomId = '420890621';
        const editLabel = eventType === 'message_updated' ? '(編集)' : '';
        await ChatworkBotUtils.sendChatworkMessage(forwardRoomId, `[info][title]${userName}${editLabel}[/title]${messageBody}[/info]`).catch(() => {});

        // Chatwork → Discord転送（新規のみ）
        if (eventType === 'message_created' && DISCORD_WEBHOOK_URL) {
          try {
            const convertCwToDiscord = (text) => text
              .replace(/\[dtext:chatroom_member_is\]/g, 'メンバー「')
              .replace(/\[dtext:chatroom_leaved\]/g, 'が退席しました。')
              .replace(/\[dtext:chatroom_added\]/g, 'を追加しました。')
              .replace(/\[dtext:chatroom_chat_joined\]/g, 'チャットに参加しました。')
              .replace(/\[info\]\[title\]([^\[]*)\[\/title\]([\s\S]*?)\[\/info\]/g, '【$1】$2')
              .replace(/\[info\]([\s\S]*?)\[\/info\]/g, '$1')
              .replace(/\[piconname:\d+\]/g, '').replace(/\[picon:\d+\]/g, '')
              .replace(/\[To:\d+\]/g, '').replace(/\[rp aid=\d+ to=\d+-\d+\]\s*/g, '（返信）')
              .replace(/\[qt\][\s\S]*?\[\/qt\]/g, '（引用）').trim();
            const converted = convertCwToDiscord(messageBody);
            if (converted) {
              const discordMsgId = await sendToDiscord(`${userName}：${converted}`);
              if (discordMsgId) {
                discordWebhookMessageIds.add(discordMsgId);
                await dbQuery(
                  'INSERT INTO discord_bridge (cw_message_id, discord_message_id, cw_account_id) VALUES ($1, $2, $3)',
                  [String(messageId), discordMsgId, String(accountId)]
                );
              }
            }
          } catch (e) {
            console.error('Chatwork→Discord転送エラー:', e.message);
          }
        }
      }

      // 地雷チェック（LOG_ROOM_IDのみ）
      if (String(roomId) === LOG_ROOM_ID) {
        const jiraiProb = await ChatworkBotUtils.getJiraiProbability(accountId, isSenderAdmin);
        if (Math.random() < jiraiProb) {
          const admins = currentMembers.filter(m => m.role === 'admin');
          if (admins.length > 0) {
            const randomAdmin = admins[Math.floor(Math.random() * admins.length)];
            await ChatworkBotUtils.sendChatworkMessage(roomId,
              `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\n地雷ふんじゃったね…\n[To:${randomAdmin.account_id}]${randomAdmin.name}に罰ゲームを考えてもらってね！`);
          }
        }
      }

      // コマンド処理
      await this.handleCommands(roomId, messageId, accountId, (messageBody || '').trim(), isSenderAdmin, isDirectChat, currentMembers, userName);
    } catch (error) {
      console.error('WebHookメッセージ処理エラー:', error.message);
    }
  }

  static updateMessageCount(roomId, accountId) {
    try {
      const now = new Date();
      const jstDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
      const todayDateOnly = jstDate.toISOString().split('T')[0];
      if (memoryStorage.roomResetDates.get(roomId) !== todayDateOnly) {
        memoryStorage.messageCounts.set(roomId, {});
        memoryStorage.roomResetDates.set(roomId, todayDateOnly);
      }
      let roomCounts = memoryStorage.messageCounts.get(roomId) || {};
      roomCounts[accountId] = (roomCounts[accountId] || 0) + 1;
      memoryStorage.messageCounts.set(roomId, roomCounts);
    } catch (error) {}
  }

  static async handleCommands(roomId, messageId, accountId, messageBody, isSenderAdmin, isDirectChat, currentMembers, userName) {
    // TOALL検出
    if (!isDirectChat && messageBody.toLowerCase().includes('toall') && !isSenderAdmin) {
      await ChatworkBotUtils.sendChatworkMessage(roomId, `[info]TOALLを検知したよ！\nフィルターが作動するよ！[/info]`);
      try {
        const admins   = currentMembers.filter(m => m.role === 'admin').map(m => String(m.account_id));
        const members  = currentMembers.filter(m => m.role === 'member' && String(m.account_id) !== String(accountId)).map(m => String(m.account_id));
        const readonly = currentMembers.filter(m => m.role === 'readonly').map(m => String(m.account_id));
        readonly.push(String(accountId));
        const params = new URLSearchParams();
        if (admins.length   > 0) params.append('members_admin_ids', admins.join(','));
        if (members.length  > 0) params.append('members_member_ids', members.join(','));
        if (readonly.length > 0) params.append('members_readonly_ids', readonly.join(','));
        await apiCallLimiter();
        await axios.put(`https://api.chatwork.com/v2/rooms/${roomId}/members`, params, { headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN } });
        await ChatworkBotUtils.addToBlackList(roomId, accountId);
      } catch (error) {}
    }

    // /miaq コマンド
    if (messageBody.startsWith('/miaq ')) {
      const parts = messageBody.substring('/miaq '.length).trim().split(/\s+/);
      const targetRoomId = parts[0], targetMessageId = parts[1];
      if (!targetRoomId || !targetMessageId) {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]つかいかたは /miaq {ルームID} {メッセージID} だよ`);
        return;
      }
      await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]Make it a Quote はDiscordの /miaq コマンドで使えるよ！`);
      return;
    }

    // /lyric コマンド
    if (messageBody.startsWith('/lyric ')) {
      const url = messageBody.substring('/lyric '.length).trim();
      if (url && (url.includes('utaten.com') || url.includes('uta-net.com') || url.includes('atwiki.jp'))) {
        const lyrics = await ChatworkBotUtils.getLyrics(url);
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${lyrics}`);
      } else {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]\nつかいかたは /lyric {utaten.com、uta-net.com、またはatwiki.jpのURL} だよ`);
      }
      return;
    }

    // Botメッセージ削除
    const deleteKeywords = ['削除', 'delete', '/del', 'けして'];
    if (deleteKeywords.some(k => messageBody.includes(k))) {
      const rpMatch = messageBody.match(/\[rp aid=(\d+) to=(\d+)-(\d+)\]/);
      if (rpMatch) {
        const targetMsg = await ChatworkBotUtils.getMessage(roomId, rpMatch[3]);
        if (targetMsg && String(targetMsg.account.account_id) === BOT_ACCOUNT_ID) {
          await ChatworkBotUtils.deleteMessage(roomId, rpMatch[3]);
        }
      }
    }

    // /song-typing-info コマンド
    if (messageBody.startsWith('/song-typing-info ')) {
      const songId = messageBody.substring('/song-typing-info '.length).trim();
      if (songId) {
        const info = await ChatworkBotUtils.getSongTypingInfo(songId);
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${info}`);
      } else {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]\nつかいかたは /song-typing-info {曲ID} だよ`);
      }
      return;
    }

    // /alarm コマンド
    if (messageBody.startsWith('/alarm ')) {
      const match = messageBody.substring('/alarm '.length).trim().match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s+(.+)$/);
      if (!match) {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]使い方: /alarm YYYY-MM-DD HH:MM メッセージ内容`);
        return;
      }
      const scheduledTime = new Date(`${match[1]}T${match[2]}:00+09:00`);
      try {
        await dbQuery('INSERT INTO alarms (room_id, scheduled_time, message, created_by) VALUES ($1, $2, $3, $4)', [roomId, scheduledTime, match[3], accountId]);
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]アラームを設定したよ！\n${scheduledTime.toLocaleString('ja-JP', {timeZone:'Asia/Tokyo'})} に「${match[3]}」を送信するね`);
      } catch (error) {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]アラーム設定に失敗しちゃった`);
      }
      return;
    }

    // /message-total
    if (messageBody === '/message-total') {
      try {
        const result = await dbQuery('SELECT account_id, message_count FROM total_message_counts WHERE room_id = $1 ORDER BY message_count DESC', [roomId]);
        if (result.rows.length === 0) {
          await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]この部屋の累計発言数はまだないみたい`);
          return;
        }
        let rankingMessage = '[info][title]累計発言数ランキング[/title]\n';
        for (let i = 0; i < result.rows.length; i++) {
          const name = await ChatworkBotUtils.getNameById(result.rows[i].account_id, currentMembers, roomId);
          rankingMessage += `${i + 1}位：${name} ${result.rows[i].message_count}コメ`;
          if (i < result.rows.length - 1) rankingMessage += '\n[hr]';
          rankingMessage += '\n';
        }
        const totalCount = result.rows.reduce((s, r) => s + parseInt(r.message_count), 0);
        rankingMessage += `\n合計：${totalCount}コメ[/info]`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${rankingMessage}`);
      } catch (error) {}
      return;
    }

    if (messageBody === 'おみくじ') {
      const result = ChatworkBotUtils.drawOmikuji(isSenderAdmin);
      await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん[info][title]おみくじ[/title]おみくじの結果は…\n\n${result}\n\nだよっ！[/info]`);
    }

    if (messageBody === 'おみくじ10連') {
      const results = Array.from({length: 10}, () => ChatworkBotUtils.drawOmikuji(isSenderAdmin));
      await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん[info][title]おみくじ10連[/title]おみくじの結果は…\n\n${results.join(' ')}\n\nだよっ！[/info]`);
    }

    // 絵文字カウント警告（非管理者のみ）
    if (!isDirectChat) {
      const emojiCount = ChatworkBotUtils.countChatworkEmojis(messageBody);
      if (emojiCount >= 50 && !isSenderAdmin) {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[info]Chatworkの絵文字を${emojiCount}個検知したよ！\nフィルターが作動するよ！[/info]`);
        try {
          const admins   = currentMembers.filter(m => m.role === 'admin').map(m => String(m.account_id));
          const members  = currentMembers.filter(m => m.role === 'member' && String(m.account_id) !== String(accountId)).map(m => String(m.account_id));
          const readonly = [...currentMembers.filter(m => m.role === 'readonly').map(m => String(m.account_id)), String(accountId)];
          const params = new URLSearchParams();
          if (admins.length   > 0) params.append('members_admin_ids', admins.join(','));
          if (members.length  > 0) params.append('members_member_ids', members.join(','));
          if (readonly.length > 0) params.append('members_readonly_ids', readonly.join(','));
          await apiCallLimiter();
          await axios.put(`https://api.chatwork.com/v2/rooms/${roomId}/members`, params, { headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN } });
          await ChatworkBotUtils.addToBlackList(roomId, accountId);
        } catch {}
      }
    }

    if (messageBody === '/yes-or-no') {
      const answer = await ChatworkBotUtils.getYesOrNoAnswer();
      await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\n答えは「${answer}」だよっ！`);
    }

    if (messageBody.startsWith('/wiki ')) {
      const searchTerm = messageBody.substring('/wiki '.length).trim();
      if (searchTerm) {
        const summary = await ChatworkBotUtils.getWikipediaSummary(searchTerm);
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\nWikipediaの検索結果だよっ！\n\n${summary}`);
      } else {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]つかいかたは /wiki 検索ワード だよ`);
      }
      return;
    }

    if (messageBody.startsWith('/info ')) {
      const targetRoomId = messageBody.substring('/info '.length).trim();
      if (!targetRoomId || !INFO_API_TOKEN) {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${!INFO_API_TOKEN ? 'ズモモエラー！！' : 'ルームIDを指定してくれるとうれしいな'}`);
        return;
      }
      if (!(isDirectChat || isSenderAdmin)) {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]このコマンドは管理者だけが使えるよ`);
        return;
      }
      try {
        const roomInfo = await ChatworkBotUtils.getRoomInfoWithToken(targetRoomId, INFO_API_TOKEN);
        if (roomInfo.error) {
          await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${roomInfo.error === 'not_found' ? '存在しないルームかも。' : 'ルーム情報持ってくるのに失敗しちゃった。'}`);
          return;
        }
        const members = await ChatworkBotUtils.getRoomMembersWithToken(targetRoomId, INFO_API_TOKEN);
        const isYuyuyuMember = members.some(m => String(m.account_id) === String(YUYUYU_ACCOUNT_ID));
        if (!isYuyuyuMember) {
          await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\nますたーが参加してないかも。`);
          return;
        }
        const iconPath = roomInfo.icon_path || '';
        const iconLink = iconPath ? (iconPath.startsWith('http') ? iconPath : `https://appdata.chatwork.com${iconPath}`) : 'なし';
        const adminNames = members.filter(m => m.role === 'admin').map(a => a.name);
        await ChatworkBotUtils.sendChatworkMessage(roomId,
          `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\n[info][title]${roomInfo.name}の情報だよっ！[/title]部屋名：${roomInfo.name}\nメンバー数：${members.length}人\n管理者数：${members.filter(m => m.role === 'admin').length}人\nルームID：${targetRoomId}\nファイル数：${roomInfo.file_num || 0}\nメッセージ数：${roomInfo.message_num || 0}\nアイコン：${iconLink}\n管理者一覧：${adminNames.join(', ') || 'なし'}[/info]`);
      } catch (error) {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]ルーム情報の取得中にエラーが発生しちゃった`);
      }
      return;
    }

    if (messageBody.startsWith('/scratch-user ')) {
      const username = messageBody.substring('/scratch-user '.length).trim();
      if (username) {
        const stats = await ChatworkBotUtils.getScratchUserStats(username);
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\nScratchのユーザー「${username}」の情報だよっ！\n\n${stats}`);
      }
      return;
    }

    if (messageBody.startsWith('/scratch-project ')) {
      const projectId = messageBody.substring('/scratch-project '.length).trim();
      if (projectId) {
        const info = await ChatworkBotUtils.getScratchProjectInfo(projectId);
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\nScratchの作品「${projectId}」の情報だよっ！\n\n${info}`);
      }
      return;
    }

    // ブラックリストコマンド（管理者専用）
    if (messageBody === '/blacklist') {
      if (!isSenderAdmin) { await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]管理者しか実行できないコマンドだよ！`); return; }
      const result = await dbQuery('SELECT account_id FROM black_list WHERE room_id = $1 ORDER BY account_id ASC', [roomId]);
      if (result.rows.length === 0) { await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]ブラックリストは空だよ`); return; }
      const freshMembers = await ChatworkBotUtils.getChatworkMembers(roomId);
      let listText = '';
      for (const row of result.rows) { listText += `・[picon:${row.account_id}]${await ChatworkBotUtils.getNameById(row.account_id, freshMembers, roomId)}\n`; }
      await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\n[info][title]ブラックリスト[/title]\n${listText}[/info]`);
      return;
    }

    if (messageBody.startsWith('/blacklist-add ')) {
      if (!isSenderAdmin) { await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]管理者しか実行できないコマンドだよ！`); return; }
      const targetIds = messageBody.substring('/blacklist-add '.length).trim().split(/\s+/).filter(Boolean);
      const added = [];
      for (const tid of targetIds) { await ChatworkBotUtils.addToBlackList(roomId, tid); added.push(`[picon:${tid}]${await ChatworkBotUtils.getNameById(tid, currentMembers, roomId)}`); }
      await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${added.join('、')}をブラックリストに追加したよ`);
      return;
    }

    if (messageBody.startsWith('/blacklist-del ')) {
      if (!isSenderAdmin) { await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]管理者しか実行できないコマンドだよ！`); return; }
      const targetIds = messageBody.substring('/blacklist-del '.length).trim().split(/\s+/).filter(Boolean);
      const deleted = [];
      for (const tid of targetIds) { await dbQuery('DELETE FROM black_list WHERE room_id = $1 AND account_id = $2', [roomId, tid]); deleted.push(`[picon:${tid}]${await ChatworkBotUtils.getNameById(tid, currentMembers, roomId)}`); }
      await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${deleted.join('、')}をブラックリストから削除したよ`);
      return;
    }

    if (messageBody === '/today') {
      const now = new Date();
      const jstDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
      const todayFormatted = jstDate.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
      let messageContent = `[info][title]今日の情報だよ[/title]今日は${todayFormatted}だよっ！`;
      const events = await getTodaysEventsFromJson();
      if (events.length > 0) events.forEach(e => { messageContent += `\n今日は${e}だよっ！`; });
      else messageContent += `\n今日は特に登録されたイベントはないみたい。`;
      messageContent += `[/info]`;
      await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\n\n${messageContent}`);
    }

    if (!isDirectChat && messageBody === '/member') {
      if (currentMembers.length > 0) {
        let reply = '[info][title]メンバー一覧[/title]\n';
        currentMembers.forEach(m => { reply += `・${m.name} (${m.role})\n`; });
        reply += '[/info]';
        await ChatworkBotUtils.sendChatworkMessage(roomId, reply);
      }
    }

    if (!isDirectChat && messageBody === '/member-name') {
      if (currentMembers.length > 0) {
        const names = currentMembers.slice().sort((a, b) => a.account_id - b.account_id).map(m => m.name).join('\n');
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[info][title]メンバー名一覧[/title]\n${names}[/info]`);
      }
    }

    if (!isDirectChat && messageBody === '/info') {
      try {
        const roomInfo = await ChatworkBotUtils.getRoomInfo(roomId);
        if (!roomInfo) { await ChatworkBotUtils.sendChatworkMessage(roomId, 'ルーム情報の取得に失敗しました。'); return; }
        const iconPath = roomInfo.icon_path || '';
        const iconLink = iconPath ? (iconPath.startsWith('http') ? iconPath : `https://appdata.chatwork.com${iconPath}`) : 'なし';
        const adminList = currentMembers.filter(m => m.role === 'admin').map(a => a.name).join(', ') || 'なし';
        await ChatworkBotUtils.sendChatworkMessage(roomId,
          `[info][title]この部屋の情報だよ[/title]部屋名：${roomInfo.name}\nメンバー数：${currentMembers.length}人\n管理者数：${currentMembers.filter(m => m.role === 'admin').length}人\nルームID：${roomId}\nファイル数：${roomInfo.file_num || 0}\nメッセージ数：${roomInfo.message_num || 0}\nアイコン：${iconLink}\n管理者一覧：${adminList}[/info]`);
      } catch {}
      return;
    }

    if (messageBody === '/romera') {
      try {
        const data = await get60DayCountsFromAPI(roomId);
        const msg = await buildRankingMessage('メッセージ数ランキングだよ', data, currentMembers, roomId);
        await ChatworkBotUtils.sendChatworkMessage(roomId, msg);
      } catch {}
    }

    // ポイントコマンド
    if (messageBody === '/points') {
      const res = await dbQuery('SELECT point FROM points WHERE room_id = $1 AND account_id = $2', [roomId, accountId]);
      await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃんの現在のポイントは ${res.rowCount > 0 ? res.rows[0].point : 0}pt だよ！`);
      return;
    }

    if (messageBody === '/points-all') {
      const res = await dbQuery('SELECT account_id, point FROM points WHERE room_id = $1 ORDER BY point DESC', [roomId]);
      if (res.rowCount === 0) { await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]まだポイントを持ってる人がいないみたい`); return; }
      let msg = '[info][title]ポイントランキング[/title]\n';
      for (let i = 0; i < res.rows.length; i++) {
        const name = await ChatworkBotUtils.getNameById(res.rows[i].account_id, currentMembers, roomId);
        msg += `${i + 1}位：[picon:${res.rows[i].account_id}]${name} ${res.rows[i].point}pt`;
        if (i < res.rows.length - 1) msg += '\n[hr]';
        msg += '\n';
      }
      await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${msg}[/info]`);
      return;
    }

    if (messageBody.startsWith('/send ')) {
      const parts = messageBody.substring('/send '.length).trim().split(/\s+/);
      const targetId = parts[0], sendPt = parseInt(parts[1]);
      if (!targetId || isNaN(sendPt) || sendPt <= 0) { await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]つかいかたは /send {ユーザーID} {ポイント} だよ`); return; }
      const myRes = await dbQuery('SELECT point FROM points WHERE room_id=$1 AND account_id=$2', [roomId, accountId]);
      const myPt = myRes.rowCount > 0 ? parseInt(myRes.rows[0].point) : 0;
      if (myPt < sendPt) { await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]ポイントが足りないよ！今持ってるのは ${myPt}pt だよ`); return; }
      await dbQuery(`UPDATE points SET point = point - $1 WHERE room_id=$2 AND account_id=$3`, [sendPt, roomId, accountId]);
      await dbQuery(`INSERT INTO points (room_id, account_id, point) VALUES ($1, $2, $3) ON CONFLICT (room_id, account_id) DO UPDATE SET point = points.point + $3, updated_at = NOW()`, [roomId, targetId, sendPt]);
      await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}][picon:${targetId}]${await ChatworkBotUtils.getNameById(targetId, currentMembers, roomId)}に ${sendPt}pt 送ったよ！`);
      return;
    }

    if (messageBody.startsWith('/point-add ')) {
      if (!['10911090','9553691'].includes(String(accountId))) { await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]このコマンドは使えないよ！`); return; }
      const parts = messageBody.substring('/point-add '.length).trim().split(/\s+/);
      const targetId = parts[0], addPt = parseInt(parts[1]);
      if (!targetId || isNaN(addPt) || addPt <= 0) return;
      await dbQuery(`INSERT INTO points (room_id, account_id, point) VALUES ($1, $2, $3) ON CONFLICT (room_id, account_id) DO UPDATE SET point = points.point + $3, updated_at = NOW()`, [roomId, targetId, addPt]);
      await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}][picon:${targetId}]${await ChatworkBotUtils.getNameById(targetId, currentMembers, roomId)}に ${addPt}pt 追加したよ！`);
      return;
    }

    if (messageBody.startsWith('/point-del ')) {
      if (!['10911090','9553691'].includes(String(accountId))) { await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]このコマンドは使えないよ！`); return; }
      const parts = messageBody.substring('/point-del '.length).trim().split(/\s+/);
      const targetId = parts[0], delPt = parseInt(parts[1]);
      if (!targetId || isNaN(delPt) || delPt <= 0) return;
      await dbQuery(`INSERT INTO points (room_id, account_id, point) VALUES ($1, $2, 0) ON CONFLICT (room_id, account_id) DO UPDATE SET point = GREATEST(points.point - $3, 0), updated_at = NOW()`, [roomId, targetId, delPt]);
      await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}][picon:${targetId}]${await ChatworkBotUtils.getNameById(targetId, currentMembers, roomId)}から ${delPt}pt 削除したよ！`);
      return;
    }

    if (messageBody.startsWith('/fever ')) {
      if (!isSenderAdmin) { await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]管理者しか実行できないコマンドだよ！`); return; }
      const arg = messageBody.substring('/fever '.length).trim();
      const mMatch = arg.match(/^(\d+)m$/), hMatch = arg.match(/^(\d+)h$/);
      let secs = mMatch ? parseInt(mMatch[1]) * 60 : hMatch ? parseInt(hMatch[1]) * 3600 : 0;
      if (secs <= 0 || secs > 10800) { await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]時間の指定がおかしいよ！5分なら 5m、3時間なら 3h（最大3時間）`); return; }
      const endsAt = new Date(Date.now() + secs * 1000);
      await dbQuery(`INSERT INTO fever (room_id, ends_at) VALUES ($1, $2) ON CONFLICT (room_id) DO UPDATE SET ends_at = $2`, [roomId, endsAt]);
      await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]🔥フィーバータイム開始！${endsAt.toLocaleString('ja-JP', {timeZone:'Asia/Tokyo'})} まで獲得ポイント10倍だよっ！`);
      return;
    }

    // NGワードコマンド（管理者専用）
    if (messageBody.startsWith('/ng ')) {
      if (!isSenderAdmin) { await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]管理者しか実行できないコマンドだよ！`); return; }
      const word = messageBody.substring('/ng '.length).trim();
      if (!word) return;
      await dbQuery('INSERT INTO ng_words (room_id, word) VALUES ($1, $2) ON CONFLICT (room_id, word) DO NOTHING', [roomId, word]);
      await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]「${word}」をNGワードに登録したよ！`);
      return;
    }

    if (messageBody.startsWith('/ok ')) {
      if (!isSenderAdmin) { await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]管理者しか実行できないコマンドだよ！`); return; }
      const word = messageBody.substring('/ok '.length).trim();
      if (!word) return;
      await dbQuery('DELETE FROM ng_words WHERE room_id = $1 AND word = $2', [roomId, word]);
      await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]「${word}」をNGワードから削除したよ！`);
      return;
    }

    if (messageBody === '/ng-check') {
      if (!isSenderAdmin) { await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]管理者しか実行できないコマンドだよ！`); return; }
      const res = await dbQuery('SELECT word FROM ng_words WHERE room_id = $1 ORDER BY created_at', [roomId]);
      if (res.rowCount === 0) { await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]NGワードはまだ登録されてないよ`); return; }
      await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}][info][title]NGワード一覧[/title]\n${res.rows.map(r => `・${r.word}`).join('\n')}[/info]`);
      return;
    }

    // /help
    if (messageBody === '/help') {
      const commonHelp =
        '[info][title]コマンド一覧だよっ！[/title]' +
        '/help - このヘルプを表示\n[hr]/today - 今日の日付とイベント\n[hr]/test - あなたとこの部屋の情報\n[hr]/info - この部屋の情報\n[hr]/member - メンバー一覧（役割付き）\n[hr]/member-name - メンバー名一覧（ID順）\n[hr]/romera - 今日のメッセージ数ランキング\n[hr]/message-total - 累計発言数ランキング\n[hr]/points - 自分のポイントを確認\n[hr]/points-all - 全員のポイントランキング\n[hr]/send {ユーザーID} {ポイント} - ポイントを送る\n[hr]/yes-or-no - yes/noをランダム回答\n[hr]/wiki 検索ワード - Wikipediaを検索\n[hr]/lyric URL - 歌詞を取得\n[hr]/song-typing-info 曲ID - 歌詞タイピング情報\n[hr]/alarm YYYY-MM-DD HH:MM メッセージ - アラームを設定\n[hr]/scratch-user ユーザー名 - Scratchユーザー情報\n[hr]/scratch-project プロジェクトID - Scratch作品情報\n[hr]/komekasegi - 過疎対策コメ連打\n[hr]/disself - 自分の権限を下げる\n[hr]おみくじ / /yes-or-no - 運試し[/info]';
      const adminHelp = isSenderAdmin ?
        '\n[info][title]管理者専用コマンドだよっ！[/title]' +
        '/info {ルームID} - 別ルームの情報を取得\n[hr]/kick {ユーザーID}... - キック\n[hr]/mute {ユーザーID}... - 閲覧のみに変更\n[hr]/blacklist - ブラックリスト確認\n[hr]/blacklist-add {ユーザーID}... - ブラックリストに追加\n[hr]/blacklist-del {ユーザーID}... - ブラックリストから削除\n[hr]/fever {時間} - フィーバータイム\n[hr]/ng {言葉} - NGワード登録\n[hr]/ok {言葉} - NGワード削除\n[hr]/ng-check - NGワード一覧\n[hr]/gakusei - 学生の地雷確率UP トグル\n[hr]/nyanko_a - nyanko_aの地雷確率UP トグル\n[hr]/milk - 牛乳の地雷確率UP トグル\n[hr]/admin - 管理者の地雷確率UP トグル\n[hr]/yuyuyu - ゆゆゆの地雷確率UP トグル\n[hr]/jirai-test - 地雷確率デバッグ\n[hr]/jirai-force - 地雷強制発動テスト[/info]'
        : '';
      await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\n${commonHelp}${adminHelp}`);
      return;
    }

    if (messageBody === '/komekasegi') {
      const messages = ['コメ稼ぎだよっ！', '過疎だね…', '静かすぎて風の音が聞こえる気がした', 'みんな寝落ちしちゃった？', 'ここって無人島かな？', '今日も平和だね', '誰か生きてるかな', '砂漠のオアシス状態', 'コメントが凍結してる…', 'しーん……'];
      for (let i = 0; i < 10; i++) {
        await ChatworkBotUtils.sendChatworkMessage(roomId, messages[Math.floor(Math.random() * messages.length)]);
        if (i < 9) await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (!isDirectChat && messageBody.startsWith('/kick ') && isSenderAdmin) {
      const targetIds = messageBody.substring('/kick '.length).trim().split(/\s+/).filter(Boolean);
      const kicked = [];
      for (const targetId of targetIds) {
        try {
          const fresh = await ChatworkBotUtils.getChatworkMembers(roomId);
          const target = fresh.find(m => String(m.account_id) === targetId);
          if (!target) continue;
          const admins   = fresh.filter(m => m.role === 'admin'    && String(m.account_id) !== targetId).map(m => String(m.account_id));
          const members  = fresh.filter(m => m.role === 'member'   && String(m.account_id) !== targetId).map(m => String(m.account_id));
          const readonly = fresh.filter(m => m.role === 'readonly' && String(m.account_id) !== targetId).map(m => String(m.account_id));
          if (admins.length === 0) continue;
          const params = new URLSearchParams();
          if (admins.length   > 0) params.append('members_admin_ids', admins.join(','));
          if (members.length  > 0) params.append('members_member_ids', members.join(','));
          if (readonly.length > 0) params.append('members_readonly_ids', readonly.join(','));
          await apiCallLimiter();
          await axios.put(`https://api.chatwork.com/v2/rooms/${roomId}/members`, params, { headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN } });
          kicked.push(`[picon:${targetId}]${await ChatworkBotUtils.getNameById(targetId, fresh, roomId)}`);
        } catch {}
      }
      if (kicked.length > 0) await ChatworkBotUtils.sendChatworkMessage(roomId, `${kicked.join('、')}をキックしたよっ！`);
      return;
    }

    if (!isDirectChat && messageBody.startsWith('/mute ') && isSenderAdmin) {
      const targetIds = messageBody.substring('/mute '.length).trim().split(/\s+/).filter(Boolean);
      const muted = [];
      for (const targetId of targetIds) {
        try {
          const fresh = await ChatworkBotUtils.getChatworkMembers(roomId);
          const target = fresh.find(m => String(m.account_id) === targetId);
          if (!target || target.role === 'readonly') continue;
          const admins   = fresh.filter(m => m.role === 'admin'    && String(m.account_id) !== targetId).map(m => String(m.account_id));
          const members  = fresh.filter(m => m.role === 'member'   && String(m.account_id) !== targetId).map(m => String(m.account_id));
          const readonly = [...fresh.filter(m => m.role === 'readonly').map(m => String(m.account_id)), targetId];
          if (admins.length === 0) continue;
          const params = new URLSearchParams();
          if (admins.length   > 0) params.append('members_admin_ids', admins.join(','));
          if (members.length  > 0) params.append('members_member_ids', members.join(','));
          if (readonly.length > 0) params.append('members_readonly_ids', readonly.join(','));
          await apiCallLimiter();
          await axios.put(`https://api.chatwork.com/v2/rooms/${roomId}/members`, params, { headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN } });
          await ChatworkBotUtils.addToBlackList(roomId, targetId);
          muted.push(`[picon:${targetId}]${await ChatworkBotUtils.getNameById(targetId, fresh, roomId)}`);
        } catch {}
      }
      if (muted.length > 0) await ChatworkBotUtils.sendChatworkMessage(roomId, `${muted.join('、')}を閲覧のみにしたよっ！`);
      return;
    }

    if (!isDirectChat && messageBody === '/disself') {
      try {
        const currentUser = currentMembers.find(m => m.account_id === accountId);
        if (!currentUser) return;
        if (currentUser.role === 'admin') {
          const admins   = currentMembers.filter(m => m.role === 'admin'    && m.account_id !== accountId).map(m => m.account_id);
          const members  = [...currentMembers.filter(m => m.role === 'member').map(m => m.account_id), accountId];
          const readonly = currentMembers.filter(m => m.role === 'readonly').map(m => m.account_id);
          const params = new URLSearchParams();
          if (admins.length   > 0) params.append('members_admin_ids', admins.join(','));
          if (members.length  > 0) params.append('members_member_ids', members.join(','));
          if (readonly.length > 0) params.append('members_readonly_ids', readonly.join(','));
          await apiCallLimiter();
          await axios.put(`https://api.chatwork.com/v2/rooms/${roomId}/members`, params, { headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN } });
        } else if (currentUser.role === 'member') {
          const admins   = currentMembers.filter(m => m.role === 'admin').map(m => m.account_id);
          const members  = currentMembers.filter(m => m.role === 'member' && m.account_id !== accountId).map(m => m.account_id);
          const readonly = [...currentMembers.filter(m => m.role === 'readonly').map(m => m.account_id), accountId];
          const params = new URLSearchParams();
          if (admins.length   > 0) params.append('members_admin_ids', admins.join(','));
          if (members.length  > 0) params.append('members_member_ids', members.join(','));
          if (readonly.length > 0) params.append('members_readonly_ids', readonly.join(','));
          await apiCallLimiter();
          await axios.put(`https://api.chatwork.com/v2/rooms/${roomId}/members`, params, { headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN } });
        }
      } catch {}
      return;
    }

    // 地雷トグルコマンド（管理者専用）
    if (messageBody === '/jirai-test') {
      if (!isSenderAdmin) { await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]管理者しか実行できないコマンドだよ！`); return; }
      const toggles = await loadJiraiToggles();
      const jiraiProb = await ChatworkBotUtils.getJiraiProbability(accountId, isSenderAdmin);
      await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\n地雷テスト\n現在の確率: ${(jiraiProb * 100).toFixed(2)}%\nルームID: ${roomId}\nLOG_ROOM_ID: ${LOG_ROOM_ID}\n一致: ${String(roomId) === LOG_ROOM_ID}\nアカウントID: ${accountId}\n管理者: ${isSenderAdmin}\n\nトグル状態:\ngakusei: ${toggles.gakusei}\nnyanko_a: ${toggles.nyanko_a}\nmilk: ${toggles.milk}\nadmin: ${toggles.admin}\nyuyuyu: ${toggles.yuyuyu}`);
      return;
    }

    if (messageBody === '/jirai-force') {
      if (!isSenderAdmin) { await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]管理者しか実行できないコマンドだよ！`); return; }
      const admins = currentMembers.filter(m => m.role === 'admin');
      if (admins.length > 0) {
        const randomAdmin = admins[Math.floor(Math.random() * admins.length)];
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\n地雷ふんじゃったね…\n[To:${randomAdmin.account_id}]${randomAdmin.name}に罰ゲームを考えてもらってね！（強制発動テスト）`);
      }
      return;
    }

    for (const [toggleName, label, prob] of [
      ['gakusei', '学生の確率UP', '25%'],
      ['nyanko_a', 'nyanko_aの確率UP', '100%'],
      ['milk', '牛乳の確率UP', '50%'],
      ['admin', '管理者の確率UP', '25%'],
      ['yuyuyu', 'ゆゆゆの確率UP', '75%']
    ]) {
      if (messageBody === `/${toggleName}`) {
        if (!isSenderAdmin) { await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]管理者しか実行できないコマンドだよ！`); return; }
        const toggles = await loadJiraiToggles();
        const newState = !toggles[toggleName];
        await saveJiraiToggle(toggleName, newState);
        await ChatworkBotUtils.sendChatworkMessage(roomId, newState ? `${label}がONになりました。(確率：${prob})` : `${label}がOFFになりました。`);
        return;
      }
    }

    const responses = {
      'はんせい': `[To:10911090] はんせい\n${userName}に呼ばれてるよっ！`,
      'ゆゆゆ': `[To:10911090] ゆゆゆ\n${userName}に呼ばれてるよっ！`,
      'からめり': `[To:10337719] からめり\n${userName}に呼ばれてるよっ！`,
      '学生': `[To:9553691] がっくせい\n${userName}に呼ばれてるよっ！`,
      'みおん': 'はーい！',
      'いろいろあぷり': 'https://shiratama-kotone.github.io/any-app/\nどーぞ！',
      '喘いでください湊音様': 'そう簡単に喘ぐとでも思った？残念！ぼくは喘ぎません...っ♡///',
      'おやすみ': 'おやすみ！',
      'おはよう': 'おはよう！',
      'プロセカやってくる': 'がんばれ！',
      'せっ': 'くす',
      '精': '子',
      '114': '514',
      'ちん': 'ちんㅤ',
      '富士山': '3776m!',
      'TOALL': '[toall...するわけないじゃん！',
      'botのコードください': 'https://github.com/shiratama-kotone/cw-bot\nどーぞ！',
      '1+1=': '1!',
      'トイレいってくる': '漏らさないでねっ！',
      '6': '9',
      'Git': 'hub',
    };
    if (responses[messageBody]) await ChatworkBotUtils.sendChatworkMessage(roomId, responses[messageBody]);

    if (messageBody === '/test') {
      const now = new Date();
      const jstNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
      const timeStr = jstNow.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      const roomInfo = await ChatworkBotUtils.getRoomInfo(roomId);
      await ChatworkBotUtils.sendChatworkMessage(roomId,
        `[rp aid=${accountId} to=${roomId}-${messageId}][info][title]あなたの情報だよっ！[/title]ユーザーID：${accountId}\nユーザー名：${userName}\nルームID：${roomId}\nルーム名：${roomInfo ? roomInfo.name : '取得失敗'}\nメッセージID：${messageId}\n時間：${timeStr}[/info]`);
    }
  }

  static isUserAdmin(accountId, allMembers) {
    const user = allMembers.find(m => m.account_id === accountId);
    return user && user.role === 'admin';
  }
}

// ============================================================
// Express.js
// ============================================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/webhook', async (req, res) => {
  try {
    const webhookEvent = req.body.webhook_event || req.body;
    if (webhookEvent?.room_id) {
      webhookEvent.webhook_event_type = req.body.webhook_event_type || 'message_created';
      webhookEvent.webhook_event_time = req.body.webhook_event_time;
      await WebHookMessageProcessor.processWebHookMessage(webhookEvent);
      res.status(200).json({ status: 'success' });
    } else {
      res.status(400).json({ error: 'Invalid webhook data' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/msg-post', async (req, res) => {
  if (req.query.roomid && req.query.msg) {
    try {
      const { roomid, msg } = req.query;
      if (!await ChatworkBotUtils.isRoomMember(roomid)) return res.status(304).json({ status: 'error', message: 'ルームに参加していません' });
      let converted = msg.replace(/\[返信\s+aid=(\d+)\s+to=([^\]]+)\]/g, '[rp aid=$1 to=$2]').replace(/\[引用\s+aid=(\d+)\s+time=(\d+)\]([\s\S]*?)\[\/引用\]/g, '[qt][qtmeta aid=$1 time=$2]$3[/qt]');
      const messageId = await ChatworkBotUtils.sendChatworkMessage(roomid, converted);
      if (messageId) res.json({ status: 'success', messageId });
      else res.status(500).json({ status: 'error', message: 'メッセージ送信に失敗しました' });
    } catch (error) {
      res.status(500).json({ status: 'error', message: error.message });
    }
    return;
  }
  res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>Chatworkメッセージ送信</title></head><body><h1>メッセージ送信フォーム</h1><form method="post" action="/msg-post"><label>ルームID: <input name="roomid" required></label><br><label>メッセージ: <textarea name="msg" required></textarea></label><br><button type="submit">送信</button></form></body></html>`);
});

app.post('/msg-post', async (req, res) => {
  try {
    const { roomid, msg } = req.body;
    if (!roomid || !msg) return res.status(400).json({ status: 'error', message: 'ルームIDとメッセージ内容は必須です' });
    if (!await ChatworkBotUtils.isRoomMember(roomid)) return res.status(400).json({ status: 'error', message: 'ルームに参加していません' });
    let converted = msg.replace(/\[返信\s+aid=(\d+)\s+to=([^\]]+)\]/g, '[rp aid=$1 to=$2]').replace(/\[引用\s+aid=(\d+)\s+time=(\d+)\]([\s\S]*?)\[\/引用\]/g, '[qt][qtmeta aid=$1 time=$2]$3[/qt]');
    const messageId = await ChatworkBotUtils.sendChatworkMessage(roomid, converted);
    if (messageId) res.json({ status: 'success', messageId, convertedMsg: converted });
    else res.status(500).json({ status: 'error', message: 'メッセージ送信に失敗しました' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'OK', message: 'ぼくは元気に稼働中！', timestamp: new Date().toISOString() });
});

app.post('/test-message', async (req, res) => {
  try {
    const { room_id, message_body, account_id, user_name } = req.body;
    if (!room_id || !message_body || !account_id || !user_name) return res.status(400).json({ error: 'required fields missing' });
    await WebHookMessageProcessor.processWebHookMessage({
      room_id, account: { account_id, name: user_name },
      body: message_body, message_id: 'test_' + Date.now(), room_type: 'group'
    });
    res.json({ status: 'success' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/status', async (req, res) => {
  const toggles = await loadJiraiToggles();
  res.json({
    status: '元気！', storage: 'PostgreSQL + Memory',
    timestamp: new Date().toISOString(), uptime: process.uptime(),
    logRoomId: LOG_ROOM_ID, botAccountId: BOT_ACCOUNT_ID,
    jiraiToggles: toggles, dbAvailable,
    memoryUsage: { apiCacheSize: API_CACHE.size }
  });
});

app.get('/test-day-events', async (req, res) => {
  const events = await getTodaysEventsFromJson();
  res.json({ status: 'success', todayEvents: events });
});

app.get('/eew-test:scale', async (req, res) => {
  try {
    const scale = parseInt(req.params.scale);
    if (isNaN(scale) || scale < 10 || scale > 70) return res.status(400).json({ error: '震度は10〜70の範囲で指定してね' });
    const testInfo = { id: `test_${Date.now()}`, time: new Date().toISOString(), hypocenter: 'ぼくの夢の中', magnitude: null, maxScale: scale };
    await ChatworkBotUtils.notifyEarthquake(testInfo, true);
    res.json({ status: 'success', earthquakeInfo: testInfo });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ランキング系ヘルパー
// ============================================================
function getTodayStartTs() {
  const now = new Date();
  const jst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  return Math.floor(new Date(jst.getFullYear(), jst.getMonth(), jst.getDate(), 0, 0, 0).getTime() / 1000);
}

async function getTodayCountsFromDB(roomId) {
  const todayStartTs = getTodayStartTs();
  const result = await dbQuery(
    `SELECT account_id, COUNT(*) as count FROM webhooks WHERE room_id = $1 AND webhook_event_type = 'message_created' AND send_time >= $2 GROUP BY account_id ORDER BY count DESC`,
    [roomId, todayStartTs]
  );
  return { rows: result.rows.map(r => ({ accountId: String(r.account_id), count: parseInt(r.count) })), expiredTotal: 0 };
}

const get60DayCountsFromAPI = getTodayCountsFromDB;

async function buildRankingMessage(title, data, members, roomId = null) {
  const { rows, expiredTotal = 0 } = (data && !Array.isArray(data) && data.rows) ? data : { rows: data || [] };
  const totalCount = rows.reduce((s, r) => s + r.count, 0);
  let msg = `[info][title]${title}[/title]\n`;
  if (rows.length === 0) {
    msg += '今日のメッセージはまだないみたい。\n';
  } else {
    for (let i = 0; i < rows.length; i++) {
      const name = await ChatworkBotUtils.getNameById(rows[i].accountId, members, roomId);
      msg += `${i + 1}位：${name} ${rows[i].count}コメ`;
      if (i < rows.length - 1) msg += '\n[hr]';
      msg += '\n';
    }
  }
  msg += `\n合計：${totalCount}コメ\n(ぼく込み)`;
  if (expiredTotal > 0) msg += `\n[hr]\n※DBに記録のない過去メッセージ：${expiredTotal}コメ`;
  msg += '[/info]';
  return msg;
}

// ============================================================
// 定期実行タスク
// ============================================================
async function sendDailyGreetingMessages() {
  try {
    const now = new Date();
    const jstDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const todayFormatted = jstDate.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
    const todayDateOnly = jstDate.toISOString().split('T')[0];

    // Chatwork通知
    for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
      if (memoryStorage.lastSentDates.get(roomId) === todayDateOnly) continue;
      let message = `[info][title]日付変更だよ[/title]今日は${todayFormatted}だよっ！`;
      const events = await getTodaysEventsFromJson();
      if (events.length > 0) events.forEach(e => { message += `\n今日は${e}だよっ！`; });
      message += `[/info]`;
      const success = await ChatworkBotUtils.sendChatworkMessage(roomId, message);
      if (success) {
        memoryStorage.lastSentDates.set(roomId, todayDateOnly);
        memoryStorage.messageCounts.set(roomId, {});
        memoryStorage.roomResetDates.set(roomId, todayDateOnly);
      }
    }

    // ★ Discord通知
    if (discordClient) {
      try {
        const channel = await discordClient.channels.fetch(DISCORD_DATE_CHANGE_CHANNEL_ID);
        if (channel) {
          let discordMsg = `📅 **日付変更！今日は${todayFormatted}だよっ！**`;
          const events = await getTodaysEventsFromJson();
          if (events.length > 0) events.forEach(e => { discordMsg += `\n🎉 今日は${e}だよっ！`; });
          await channel.send(discordMsg);
          console.log(`Discord日付変更通知送信完了: ${DISCORD_DATE_CHANGE_CHANNEL_ID}`);
        }
      } catch (e) {
        console.error('Discord日付変更通知エラー:', e.message);
      }
    }
  } catch (error) {
    console.error('日付変更通知処理エラー:', error.message);
  }
}

async function sendNightMessage() {
  const message = '11時だよ！ぼくはもう眠くなってきちゃった…';
  for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
    await ChatworkBotUtils.sendChatworkMessage(roomId, message).catch(() => {});
  }
}

async function ohayosekai() {
  const message = 'おはようせかい';
  for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
    await ChatworkBotUtils.sendChatworkMessage(roomId, message).catch(() => {});
  }
}

async function sendDailyRanking() {
  for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
    try {
      const data = await get60DayCountsFromAPI(roomId);
      const members = await ChatworkBotUtils.getChatworkMembers(roomId);
      const msg = await buildRankingMessage('コメ数ランキング！', data, members, roomId);
      await ChatworkBotUtils.sendChatworkMessage(roomId, '今日のコメ数ランキングだよっ！\n' + msg);
    } catch {}
  }
}

async function sendPreMidnightRanking() {
  for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
    try {
      const data = await get60DayCountsFromAPI(roomId);
      const members = await ChatworkBotUtils.getChatworkMembers(roomId);
      const msg = await buildRankingMessage('日付変更の前のランキング', data, members, roomId);
      await ChatworkBotUtils.sendChatworkMessage(roomId, msg);
    } catch {}
  }
}

async function sendMorningMessage() {
  const message = 'みんなおはよう！\nぼくはまだ眠いなぁ';
  for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
    await ChatworkBotUtils.sendChatworkMessage(roomId, message).catch(() => {});
  }
  await sendTodayWeather();
}

async function sendTodayWeather() {
  for (const area of WEATHER_AREAS) {
    const weatherData = await ChatworkBotUtils.getWeatherForecast(area.code);
    if (!weatherData?.forecasts?.length) continue;
    const today = weatherData.forecasts[0];
    const telop = today.telop || '不明';
    const maxTemp = today.temperature.max ? `${today.temperature.max.celsius}℃` : '不明';
    const minTemp = today.temperature.min?.celsius ? `${today.temperature.min.celsius}℃` : null;
    let message = `[info][title]たぶん${area.name}の今日の天気予報[/title]天気は${telop}だよ\n最高気温は${maxTemp}だよ`;
    if (minTemp) message += `\n最低気温はたぶん${minTemp}だよ`;
    message += `\n天気概況文はいらない！\nぼくの判断。[/info]`;
    for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
      await ChatworkBotUtils.sendChatworkMessage(roomId, message).catch(() => {});
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

async function sendTomorrowWeather() {
  for (const area of WEATHER_AREAS) {
    const weatherData = await ChatworkBotUtils.getWeatherForecast(area.code);
    if (!weatherData?.forecasts || weatherData.forecasts.length < 2) continue;
    const tomorrow = weatherData.forecasts[1];
    const telop = tomorrow.telop || '不明';
    const maxTemp = tomorrow.temperature.max ? `${tomorrow.temperature.max.celsius}℃` : '不明';
    const minTemp = tomorrow.temperature.min?.celsius ? `${tomorrow.temperature.min.celsius}℃` : null;
    let message = `[info][title]たぶん${area.name}の明日の天気予報[/title]天気は${telop}だよ\n最高気温は${maxTemp}だよ`;
    if (minTemp) message += `\n最低気温はたぶん${minTemp}だよ`;
    message += `\n天気概況文はいらない！\nぼくの判断。[/info]`;
    for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
      await ChatworkBotUtils.sendChatworkMessage(roomId, message).catch(() => {});
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

async function checkEarthquakeInfo() {
  try {
    const info = await ChatworkBotUtils.getLatestEarthquakeInfo();
    if (info && info.id !== memoryStorage.lastEarthquakeId) {
      await ChatworkBotUtils.notifyEarthquake(info);
      memoryStorage.lastEarthquakeId = info.id;
    }
  } catch {}
}

async function cleanupOldMessageLogs() {
  try {
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    await dbQuery('DELETE FROM message_logs WHERE created_at < $1 AND room_id = $2', [twoDaysAgo, LOG_ROOM_ID]);
  } catch {}
}

async function checkAndSendAlarms() {
  try {
    const now = new Date();
    const result = await dbQuery('SELECT * FROM alarms WHERE scheduled_time <= $1', [now]);
    for (const alarm of result.rows) {
      // Chatworkへ送信
      if (alarm.room_id) {
        await ChatworkBotUtils.sendChatworkMessage(alarm.room_id, alarm.message).catch(() => {});
      }
      // ★ Discordチャンネルへ送信
      if (alarm.discord_channel_id && discordClient) {
        try {
          const ch = await discordClient.channels.fetch(alarm.discord_channel_id);
          if (ch) await ch.send(`⏰ ${alarm.message}`);
        } catch (e) {
          console.error('Discordアラーム送信エラー:', e.message);
        }
      }
      await dbQuery('DELETE FROM alarms WHERE id = $1', [alarm.id]);
    }
  } catch {}
}

async function checkNhkNews() {
  try {
    const response = await axios.get('https://api.web.nhk/sokuho/news/sokuho_news.xml', {
      timeout: 8000, headers: { 'User-Agent': 'ChatworkBot/1.0' }
    });
    const xml = response.data;
    const flagMatch = xml.match(/<flashNews[^>]*flag="(\d+)"/);
    if (!flagMatch || flagMatch[1] !== '1') return;
    const reportMatch = xml.match(/<report[^>]*id="([^"]+)"[^>]*>/);
    const lineMatch = xml.match(/<line>([\s\S]*?)<\/line>/);
    if (!reportMatch || !lineMatch) return;
    const reportId = reportMatch[1];
    const lineText = lineMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    if (reportId === memoryStorage.lastNhkNewsId) return;
    memoryStorage.lastNhkNewsId = reportId;
    const linkMatch = xml.match(/link="([^"]+)"/);
    const link = linkMatch ? linkMatch[1] : '';
    const message = `[info][title]📢 NHK速報[/title]${lineText}${link ? '\n' + link : ''}[/info]`;
    for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
      await ChatworkBotUtils.sendChatworkMessage(roomId, message).catch(() => {});
      await new Promise(r => setTimeout(r, 300));
    }
  } catch {}
}

const WARNING_NAMES = {
  '暴風警報': '🌀', '大雨警報': '🌧️', '洪水警報': '🌊', '大雪警報': '❄️',
  '暴風雪警報': '🌨️', '波浪警報': '🌊', '高潮警報': '🌊',
  '暴風注意報': '💨', '大雨注意報': '🌧️', '洪水注意報': '🌊', '大雪注意報': '❄️',
  '雷注意報': '⚡', '濃霧注意報': '🌫️', '乾燥注意報': '🔥', '強風注意報': '💨',
  '波浪注意報': '🌊', '高潮注意報': '🌊', '霜注意報': '🧊', '低温注意報': '🥶'
};
const WARNING_TARGET_PREFS = ['270000', '400000', '010000', '230000', '470000'];

async function checkJmaWarnings() {
  try {
    const response = await axios.get('https://www.jma.go.jp/bosai/warning/data/warning/map.json', {
      timeout: 8000, headers: { 'User-Agent': 'ChatworkBot/1.0' }
    });
    const data = response.data;
    for (const prefCode of WARNING_TARGET_PREFS) {
      const prefData = data[prefCode];
      if (!prefData) continue;
      const prefName = prefData.areaName || prefCode;
      const currentWarnings = new Set();
      if (prefData.warning?.items) {
        for (const item of prefData.warning.items) {
          if (item.warnings) {
            for (const w of item.warnings) {
              if (w.status === '発表' || w.status === '継続') currentWarnings.add(w.type);
            }
          }
        }
      }
      const prevWarnings = memoryStorage.sentWarnings.get(prefCode) || new Set();
      const newIssued = [...currentWarnings].filter(w => !prevWarnings.has(w));
      const newLifted = [...prevWarnings].filter(w => !currentWarnings.has(w));
      if (newIssued.length > 0) {
        const icons = newIssued.map(w => `${WARNING_NAMES[w] || '⚠️'} ${w}`).join('、');
        const message = `[info][title]⚠️ 気象警報・注意報 発令[/title]${prefName}に\n${icons}\nが発令されました。引き続き情報に注意してね！[/info]`;
        for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
          await ChatworkBotUtils.sendChatworkMessage(roomId, message).catch(() => {});
          await new Promise(r => setTimeout(r, 300));
        }
      }
      if (newLifted.length > 0) {
        const icons = newLifted.map(w => `${WARNING_NAMES[w] || '⚠️'} ${w}`).join('、');
        const message = `[info][title]✅ 気象警報・注意報 解除[/title]${prefName}の\n${icons}\nが解除されました。[/info]`;
        for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
          await ChatworkBotUtils.sendChatworkMessage(roomId, message).catch(() => {});
          await new Promise(r => setTimeout(r, 300));
        }
      }
      memoryStorage.sentWarnings.set(prefCode, currentWarnings);
    }
  } catch {}
}

async function send311Memorial() {
  const yearsSince = new Date().getFullYear() - 2011;
  const message = `今日は3月11日。東日本大震災から${yearsSince}年が経ちました。\n2011年3月11日14時46分、日本は観測史上最大級の地震と大津波に見舞われ、多くの尊い命が失われました。\n今もなお、あの日の記憶や想いを胸に生きている方々がいます。\n\n普段の何気ない日常が、決して当たり前ではないことを改めて考える日でもあります。\n震災で亡くなられた方々、そして被災されたすべての方々に心を寄せたいと思います。\n\nまもなく14時46分です。\n犠牲になられた方々へ、黙祷を捧げましょう。`;
  for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
    await ChatworkBotUtils.sendChatworkMessage(roomId, message).catch(() => {});
  }
}

async function send311Silence() {
  for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
    await ChatworkBotUtils.sendChatworkMessage(roomId, '黙祷').catch(() => {});
  }
}

// ============================================================
// cronスケジュール
// ============================================================
cron.schedule('0 0 0 * * *',  async () => { await ohayosekai(); },              { timezone: 'Asia/Tokyo' });
cron.schedule('0 0 0 * * *',  async () => { await sendDailyGreetingMessages(); }, { timezone: 'Asia/Tokyo' });
cron.schedule('5 0 0 * * *',  async () => { await cleanupOldMessageLogs(); },   { timezone: 'Asia/Tokyo' });
cron.schedule('0 0 23 * * *', async () => { await sendNightMessage(); },         { timezone: 'Asia/Tokyo' });
cron.schedule('0 55 23 * * *',async () => { await sendPreMidnightRanking(); },  { timezone: 'Asia/Tokyo' });
cron.schedule('0 59 23 * * *',async () => { await sendDailyRanking(); },         { timezone: 'Asia/Tokyo' });
cron.schedule('0 0 6 * * *',  async () => { await sendMorningMessage(); },       { timezone: 'Asia/Tokyo' });
cron.schedule('0 0 18 * * *', async () => { await sendTomorrowWeather(); },      { timezone: 'Asia/Tokyo' });
cron.schedule('*/1 * * * *',  async () => { await checkEarthquakeInfo(); },      { timezone: 'Asia/Tokyo' });
cron.schedule('*/1 * * * *',  async () => { await checkAndSendAlarms(); },       { timezone: 'Asia/Tokyo' });
cron.schedule('*/1 * * * *',  async () => { await checkNhkNews(); },             { timezone: 'Asia/Tokyo' });
cron.schedule('*/1 * * * *',  async () => { await checkJmaWarnings(); },         { timezone: 'Asia/Tokyo' });
cron.schedule('45 14 11 3 *', async () => { await send311Memorial(); },          { timezone: 'Asia/Tokyo' });
cron.schedule('46 14 11 3 *', async () => { await send311Silence(); },           { timezone: 'Asia/Tokyo' });

// ============================================================
// ★ Discord連携
// ============================================================
async function sendToDiscord(content) {
  if (!DISCORD_WEBHOOK_URL) return null;
  try {
    const res = await axios.post(DISCORD_WEBHOOK_URL + '?wait=true', { content }, {
      headers: { 'Content-Type': 'application/json' }
    });
    return res.data.id || null;
  } catch (e) {
    console.error('Discord送信エラー:', e.message);
    return null;
  }
}

let discordClient = null;
const discordWebhookMessageIds = new Set();

if (DISCORD_BOT_TOKEN) {
  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  discordClient.once(Events.ClientReady, async (c) => {
    console.log(`Discord bot 起動: ${c.user.tag}`);

    // ★ スラッシュコマンド定義（Chatworkアカウント不要な機能のみ）
    const commands = [
      // 情報・ゲーム系
      new SlashCommandBuilder()
        .setName('おみくじ')
        .setDescription('おみくじを引くよっ！'),
      new SlashCommandBuilder()
        .setName('yes_or_no')
        .setDescription('yes/noをランダム回答するよ'),
      new SlashCommandBuilder()
        .setName('wiki')
        .setDescription('Wikipediaを検索するよ')
        .addStringOption(o => o.setName('word').setDescription('検索ワード').setRequired(true)),
      new SlashCommandBuilder()
        .setName('today')
        .setDescription('今日の日付とイベントを表示するよ'),
      new SlashCommandBuilder()
        .setName('alarm')
        .setDescription('このチャンネルにアラームを設定するよ')
        .addStringOption(o => o.setName('datetime').setDescription('日時（YYYY-MM-DD HH:MM）').setRequired(true))
        .addStringOption(o => o.setName('message').setDescription('メッセージ').setRequired(true)),
      new SlashCommandBuilder()
        .setName('miaq')
        .setDescription('メッセージをMake it a Quoteにするよ')
        .addStringOption(o => o.setName('message_id').setDescription('対象のメッセージID').setRequired(true)),
      // ★ 投稿規制（Discord側、実行チャンネルで動作）
      new SlashCommandBuilder()
        .setName('prohibit')
        .setDescription('このチャンネルで発言禁止にするよ（管理者専用）')
        .addStringOption(o => o.setName('duration').setDescription('時間（例: 5m, 1h、最大3h）').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
      new SlashCommandBuilder()
        .setName('release')
        .setDescription('このチャンネルの発言禁止を解除するよ（管理者専用）')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
      // ★ メッセージ削除
      new SlashCommandBuilder()
        .setName('clear')
        .setDescription('指定された数だけメッセージを削除するよ（管理者専用）')
        .addIntegerOption(o => o.setName('count').setDescription('削除するメッセージ数（1〜100）').setRequired(true).setMinValue(1).setMaxValue(100))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
      // ヘルプ
      new SlashCommandBuilder()
        .setName('help')
        .setDescription('コマンド一覧を表示するよ'),
    ].map(cmd => cmd.toJSON());

    try {
      const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
      await rest.put(Routes.applicationCommands(c.user.id), { body: commands });
      console.log('Discordスラッシュコマンド登録完了');
    } catch (e) {
      console.error('スラッシュコマンド登録エラー:', e.message);
    }
  });

  // ★ スラッシュコマンド処理
  discordClient.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction.commandName;
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) || false;

    try {
      await interaction.deferReply();

      // ★ /help
      if (cmd === 'help') {
        const msg = [
          '**📋 コマンド一覧**',
          '`/おみくじ` - おみくじを引くよっ！',
          '`/yes_or_no` - yes/noをランダム回答',
          '`/wiki [word]` - Wikipedia検索',
          '`/today` - 今日の日付とイベント',
          '`/alarm [datetime] [message]` - アラーム設定（このチャンネルに通知）',
          '`/miaq [message_id]` - Make it a Quote',
          '',
          '**🔒 管理者専用**',
          '`/prohibit [duration]` - このチャンネルで発言禁止（例: 5m, 1h）',
          '`/release` - このチャンネルの発言禁止を解除',
          '`/clear [count]` - メッセージを指定数削除（最大100件）',
        ].join('\n');
        await interaction.editReply(msg);
        return;
      }

      // ★ /おみくじ
      if (cmd === 'おみくじ') {
        const result = ChatworkBotUtils.drawOmikuji(isAdmin);
        await interaction.editReply(`🎋 おみくじの結果は…\n**${result}**\nだよっ！`);
        return;
      }

      // ★ /yes_or_no
      if (cmd === 'yes_or_no') {
        const answer = await ChatworkBotUtils.getYesOrNoAnswer();
        await interaction.editReply(`答えは「**${answer}**」だよっ！`);
        return;
      }

      // ★ /wiki
      if (cmd === 'wiki') {
        const word = interaction.options.getString('word');
        const summary = await ChatworkBotUtils.getWikipediaSummary(word);
        await interaction.editReply(summary.substring(0, 1900));
        return;
      }

      // ★ /today
      if (cmd === 'today') {
        const now = new Date();
        const jst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
        const dateStr = jst.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
        const events = await getTodaysEventsFromJson();
        let msg = `📅 今日は**${dateStr}**だよっ！`;
        if (events.length > 0) events.forEach(e => { msg += `\n🎉 今日は${e}だよっ！`; });
        await interaction.editReply(msg);
        return;
      }

      // ★ /alarm （このチャンネルに通知）
      if (cmd === 'alarm') {
        const datetime = interaction.options.getString('datetime');
        const msg = interaction.options.getString('message');
        const match = datetime.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})$/);
        if (!match) { await interaction.editReply('日時の形式がおかしいよ！例: `2026-04-10 15:30`'); return; }
        const scheduledTime = new Date(`${match[1]}T${match[2]}:00+09:00`);
        if (isNaN(scheduledTime.getTime())) { await interaction.editReply('日時の解析に失敗したよ…'); return; }
        await dbQuery(
          'INSERT INTO alarms (room_id, discord_channel_id, scheduled_time, message, created_by) VALUES ($1, $2, $3, $4, $5)',
          [0, interaction.channelId, scheduledTime, msg, 0]
        );
        await interaction.editReply(`⏰ アラームを設定したよ！\n**${scheduledTime.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}** に「${msg}」を送信するね`);
        return;
      }

      // ★ /miaq
      if (cmd === 'miaq') {
        const targetMsgId = interaction.options.getString('message_id');
        try {
          const targetMsg = await interaction.channel.messages.fetch(targetMsgId);
          if (!targetMsg) { await interaction.editReply('メッセージが見つからなかったよ'); return; }
          const text = targetMsg.content || '';
          const author = targetMsg.member?.displayName || targetMsg.author.username;
          const miaqRes = await axios.post('https://makeit-a66a.onrender.com/', {
            text, name: author, id: targetMsg.author.id
          }, { headers: { 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 20000 });
          const attachment = new AttachmentBuilder(Buffer.from(miaqRes.data), { name: 'quote.png' });
          await interaction.editReply({ files: [attachment] });
        } catch (e) {
          await interaction.editReply(`エラーが発生したよ: ${e.message}`);
        }
        return;
      }

      // ★ /prohibit （このチャンネルで発言禁止）
      if (cmd === 'prohibit') {
        if (!isAdmin) { await interaction.editReply('管理者しか実行できないコマンドだよ！'); return; }
        const arg = interaction.options.getString('duration');
        const mM = arg.match(/^(\d+)m$/), hM = arg.match(/^(\d+)h$/);
        let secs = mM ? parseInt(mM[1]) * 60 : hM ? parseInt(hM[1]) * 3600 : 0;
        if (secs <= 0 || secs > 10800) { await interaction.editReply('時間の指定がおかしいよ！5分なら `5m`、3時間なら `3h`（最大3時間）'); return; }
        const endsAt = new Date(Date.now() + secs * 1000);
        await dbQuery(
          'INSERT INTO discord_prohibit (channel_id, ends_at) VALUES ($1, $2) ON CONFLICT (channel_id) DO UPDATE SET ends_at = $2',
          [interaction.channelId, endsAt]
        );
        await interaction.editReply(`🚫 **${endsAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}** まで、このチャンネルで発言禁止にしたよ！\n（管理者のメッセージは削除しません）`);
        return;
      }

      // ★ /release
      if (cmd === 'release') {
        if (!isAdmin) { await interaction.editReply('管理者しか実行できないコマンドだよ！'); return; }
        await dbQuery('DELETE FROM discord_prohibit WHERE channel_id = $1', [interaction.channelId]);
        await interaction.editReply('✅ このチャンネルの発言禁止を解除したよ！');
        return;
      }

      // ★ /clear
      if (cmd === 'clear') {
        if (!isAdmin) { await interaction.editReply('管理者しか実行できないコマンドだよ！'); return; }
        const count = interaction.options.getInteger('count');
        try {
          // Discord API はバルク削除で最大100件、14日以内のメッセージのみ
          const fetched = await interaction.channel.messages.fetch({ limit: count });
          const deletable = fetched.filter(m => (Date.now() - m.createdTimestamp) < 14 * 24 * 60 * 60 * 1000);
          if (deletable.size === 0) {
            await interaction.editReply('削除できるメッセージがないよ（14日以上前のメッセージは削除できないよ）');
            return;
          }
          await interaction.channel.bulkDelete(deletable, true);
          await interaction.editReply(`🗑️ ${deletable.size}件のメッセージを削除したよ！`);
        } catch (e) {
          console.error('/clearエラー:', e.message);
          await interaction.editReply(`削除中にエラーが発生したよ: ${e.message}`);
        }
        return;
      }

      await interaction.editReply('不明なコマンドだよ');
    } catch (e) {
      console.error('Discordスラッシュコマンドエラー:', e.message);
      try {
        if (!interaction.replied && !interaction.deferred) await interaction.reply('エラーが発生したよ');
        else await interaction.editReply('エラーが発生したよ');
      } catch {}
    }
  });

  // ★ Discordメッセージ処理（投稿規制チェック + Chatwork転送）
  discordClient.on(Events.MessageCreate, async (message) => {
    try {
      if (message.author.bot) return;

      // ★ 投稿規制チェック（管理者は除外）
      const isAdmin = message.member?.permissions?.has(PermissionFlagsBits.ManageMessages) || false;
      if (!isAdmin) {
        const prohibitResult = await dbQuery(
          'SELECT ends_at FROM discord_prohibit WHERE channel_id = $1 AND ends_at > NOW()',
          [message.channel.id]
        );
        if (prohibitResult.rowCount > 0) {
          await message.delete().catch(() => {});
          const warn = await message.channel.send(`<@${message.author.id}> 現在このチャンネルは発言禁止中だよ！`).catch(() => null);
          if (warn) setTimeout(() => warn.delete().catch(() => {}), 5000);
          return;
        }
      }

      // Chatwork連携チャンネルのみ転送
      if (message.channel.id !== DISCORD_BRIDGE_CHANNEL_ID) return;
      if (discordWebhookMessageIds.has(message.id)) {
        discordWebhookMessageIds.delete(message.id);
        return;
      }

      const userName = message.member?.displayName || message.author.displayName || message.author.username;
      const content = message.content || '';
      if (!content) return;

      let cwMessage = '';
      if (message.reference?.messageId) {
        const result = await dbQuery('SELECT cw_message_id, cw_account_id FROM discord_bridge WHERE discord_message_id = $1', [message.reference.messageId]);
        if (result.rowCount > 0 && result.rows[0].cw_message_id) {
          const cwMsgId = result.rows[0].cw_message_id;
          const cwAccId = result.rows[0].cw_account_id || '0';
          cwMessage = `[rp aid=${cwAccId} to=${DISCORD_BRIDGE_CW_ROOM_ID}-${cwMsgId}][info][title]Discord[/title]${userName}：${content}[/info]`;
        } else {
          cwMessage = `[info][title]Discord（返信）[/title]${userName}：${content}[/info]`;
        }
      } else {
        cwMessage = `[info][title]Discord[/title]${userName}：${content}[/info]`;
      }

      const cwMsgId = await ChatworkBotUtils.sendChatworkMessage(DISCORD_BRIDGE_CW_ROOM_ID, cwMessage);
      if (cwMsgId) {
        await dbQuery(
          'INSERT INTO discord_bridge (cw_message_id, discord_message_id, cw_account_id) VALUES ($1, $2, $3)',
          [String(cwMsgId), message.id, '0']
        );
      }
    } catch (e) {
      console.error('Discord→Chatwork転送エラー:', e.message);
    }
  });

  discordClient.login(DISCORD_BOT_TOKEN).catch(e => {
    console.error('Discord bot ログインエラー:', e.message);
  });
}

// ============================================================
// サーバー起動
// ============================================================
app.listen(port, async () => {
  console.log(`みおんがポート${port}で起動しました`);
  console.log('環境変数:');
  console.log('- CHATWORK_API_TOKEN:', CHATWORK_API_TOKEN ? '設定済みだよ' : '未設定かも');
  console.log('- DISCORD_BOT_TOKEN:', DISCORD_BOT_TOKEN ? '設定済みだよ' : '未設定かも');
  console.log('- DISCORD_WEBHOOK_URL:', DISCORD_WEBHOOK_URL ? '設定済みだよ' : '未設定かも');
  console.log('- DB_URL:', DB_URL ? `設定済みだよ (${DB_URL.includes('pooler.supabase.com') ? 'pooler' : 'direct'})` : '未設定かも');

  console.log('\nデータベースを初期化するね...');
  const dbOk = await checkDbConnection();
  console.log('DB接続:', dbOk ? '✅ 成功' : '❌ 失敗（DB不要な機能は動くよ）');
  if (dbOk) await initializeDatabase();

  console.log('\nメッセージカウントを初期化するね...');
  for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
    try {
      await ChatworkBotUtils.initializeMessageCount(roomId);
      await new Promise(r => setTimeout(r, 1000));
    } catch {}
  }

  console.log('\n累計発言数を初期化するね...');
  for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
    try {
      if (dbOk) await ChatworkBotUtils.initializeTotalMessageCounts(roomId);
      await new Promise(r => setTimeout(r, 500));
    } catch {}
  }

  console.log('\n地雷トグル状態を確認するね...');
  try {
    const toggles = await loadJiraiToggles();
    console.log('地雷トグル状態:', JSON.stringify(toggles, null, 2));
  } catch {}

  console.log('\n起動通知を送信するね...');
  for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
    await ChatworkBotUtils.sendChatworkMessage(roomId, '湊音が起動したよっ！').catch(() => {});
  }

  console.log('起動かんりょ！\n');
});
