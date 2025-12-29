// Chatwork Bot for Render (WebHook版 - 全ルーム対応)
// server.js - 修正版（機能追加・削除版）

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { Pool } = require('pg');
const cheerio = require('cheerio');

const app = express();
const port = process.env.PORT || 3000;

// PostgreSQL接続設定
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// データベース初期化
async function initializeDatabase() {
  try {
    await pool.query(`
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

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_webhooks_room_id ON webhooks(room_id);
      CREATE INDEX IF NOT EXISTS idx_webhooks_send_time ON webhooks(send_time);
      CREATE INDEX IF NOT EXISTS idx_webhooks_room_send ON webhooks(room_id, send_time);
    `);

    console.log('データベーステーブル初期化完了');
  } catch (error) {
    console.error('データベース初期化エラー:', error.message);
  }
}

// 環境変数から設定を読み込み
const CHATWORK_API_TOKEN = process.env.CHATWORK_API_TOKEN || '';
const INFO_API_TOKEN = process.env.INFO_API_TOKEN || '';
const DIRECT_CHAT_WITH_DATE_CHANGE = (process.env.DIRECT_CHAT_WITH_DATE_CHANGE || '405497983,407676893,415060980,406897783,391699365').split(',');
const LOG_ROOM_ID = '404646956';
const DAY_JSON_URL = process.env.DAY_JSON_URL || 'https://raw.githubusercontent.com/shiratama-kotone/cw-bot/main/day.json';
const YUYUYU_ACCOUNT_ID = '10544705';

// 追加: 天気予報用設定
const WEATHER_API_BASE = 'https://weather.tsukumijima.net/api/forecast/city';
const WEATHER_REGIONS = [
  { name: '東京', code: '130010' },
  { name: '大阪', code: '270000' },
  { name: '名古屋', code: '230010' },
  { name: '横浜', code: '140010' },
  { name: '福岡', code: '400010' }
];

// メモリ内データストレージ
const memoryStorage = {
  properties: new Map(),
  lastSentDates: new Map(),
  messageCounts: new Map(),
  roomResetDates: new Map(),
  lastEarthquakeId: null,
};

// Chatwork APIレートミット制御
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

// Chatwork絵文字のリスト
const CHATWORK_EMOJI_CODES = [
  "roger", "bow", "cracker", "dance", "clap", "y", "sweat", "blush", "inlove",
  "talk", "yawn", "puke", "emo", "nod", "shake", "^^;", ":/", "whew", "flex",
  "gogo", "think", "please", "quick", "anger", "devil", "lightbulb", "h", "F",
  "eat", "^", "coffee", "beer", "handshake"
].map(code => code.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'));
const CHATWORK_EMOJI_REGEX = new RegExp(`\\((${CHATWORK_EMOJI_CODES.join('|')})\\)`, 'g');

// APIキャッシュ
const API_CACHE = new Map();
const MAX_CACHE_SIZE = 50;

function addToCache(key, value) {
  if (API_CACHE.size >= MAX_CACHE_SIZE) {
    const firstKey = API_CACHE.keys().next().value;
    API_CACHE.delete(firstKey);
  }
  API_CACHE.set(key, value);
}

// day.json読み込み関数
async function loadDayEvents() {
  try {
    const response = await axios.get(DAY_JSON_URL);
    console.log('day.json読み込み成功');
    return response.data;
  } catch (error) {
    console.error('day.json読み込みエラー:', error.message);
    return {};
  }
}

// 今日のイベント取得
async function getTodaysEventsFromJson() {
  try {
    const dayEvents = await loadDayEvents();
    const now = new Date();
    const jstDate = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
    const monthDay = `${String(jstDate.getMonth() + 1).padStart(2, '0')}-${String(jstDate.getDate()).padStart(2, '0')}`;

    const events = [];

    // MM-DD形式のイベントのみチェック
    if (dayEvents[monthDay]) {
      if (Array.isArray(dayEvents[monthDay])) {
        events.push(...dayEvents[monthDay]);
      } else {
        events.push(dayEvents[monthDay]);
      }
    }

    return events;
  } catch (error) {
    console.error('今日のイベント取得エラー:', error.message);
    return [];
  }
}

// ユーティリティ関数
class ChatworkBotUtils {
  static async getChatworkMembers(roomId) {
    await apiCallLimiter();
    try {
      const response = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}/members`, {
        headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
      });
      return response.data.map(member => ({
        account_id: member.account_id,
        name: member.name,
        role: member.role
      }));
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
      const response = await axios.post(`https://api.chatwork.com/v2/rooms/${roomId}/messages`,
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
      if (sourceRoomId !== LOG_ROOM_ID) {
        return;
      }
      const logMessage = `[info][title]${userName}[/title]${messageBody}[/info]`;
      console.log(`ログ送信: ルーム ${LOG_ROOM_ID} へ`);
      await this.sendChatworkMessage(LOG_ROOM_ID, logMessage);
      console.log(`ログ送信完了: ルーム ${LOG_ROOM_ID}`);
    } catch (error) {
      console.error('Chatworkログ送信エラー:', error.message);
    }
  }

  static countChatworkEmojis(text) {
    const matches = text.match(CHATWORK_EMOJI_REGEX);
    return matches ? matches.length : 0;
  }

  static drawOmikuji(isAdmin) {
    const fortunes = ['大吉', '中吉', '吉', '小吉', '末吉', '凶'];
    const specialFortune = '超町長調帳朝腸蝶大吉';
    let specialChance = 0.002;
    if (isAdmin) specialChance = 0.25;
    const rand = Math.random();
    if (rand < specialChance) {
      return specialFortune;
    } else {
      const index = Math.floor(Math.random() * fortunes.length);
      return fortunes[index];
    }
  }

  static async getYesOrNoAnswer() {
    const answers = ['yes', 'no'];
    try {
      const response = await axios.get('https://yesno.wtf/api');
      return response.data.answer || answers[Math.floor(Math.random() * answers.length)];
    } catch (error) {
      return answers[Math.floor(Math.random() * answers.length)];
    }
  }

  // Wikipedia API修正版
  static async getWikipediaSummary(searchTerm) {
    const now = Date.now();
    const cacheKey = `wiki_${searchTerm}`;

    if (API_CACHE.has(cacheKey)) {
      const cachedData = API_CACHE.get(cacheKey);
      if (now - cachedData.timestamp < 300000) {
        return cachedData.data;
      }
    }

    try {
      // OpenSearch APIで検索
      const searchParams = new URLSearchParams({
        action: 'opensearch',
        format: 'json',
        search: searchTerm,
        limit: 1,
        namespace: 0,
        redirects: 'resolve'
      });

      const searchResponse = await axios.get(`https://ja.wikipedia.org/w/api.php?${searchParams}`, {
        timeout: 10000,
        headers: {
          'User-Agent': 'ChatworkBot/1.0'
        }
      });

      const searchData = searchResponse.data;
      
      if (!searchData || !searchData[1] || searchData[1].length === 0) {
        const result = `「${searchTerm}」に関する記事は見つかりませんでした。`;
        addToCache(cacheKey, { data: result, timestamp: now });
        return result;
      }

      const pageTitle = searchData[1][0];
      const pageUrl = searchData[3][0];

      // TextExtracts APIで要約を取得
      const extractParams = new URLSearchParams({
        action: 'query',
        format: 'json',
        prop: 'extracts',
        exintro: true,
        explaintext: true,
        titles: pageTitle,
        redirects: 1
      });

      const extractResponse = await axios.get(`https://ja.wikipedia.org/w/api.php?${extractParams}`, {
        timeout: 10000,
        headers: {
          'User-Agent': 'ChatworkBot/1.0'
        }
      });

      const extractData = extractResponse.data;
      
      if (extractData.query && extractData.query.pages) {
        const pages = extractData.query.pages;
        const pageId = Object.keys(pages)[0];
        
        if (pageId && pageId !== '-1' && pages[pageId] && pages[pageId].extract) {
          let summary = pages[pageId].extract;
          if (summary.length > 500) {
            summary = summary.substring(0, 500) + '...';
          }
          const result = `${summary}\n\n元記事: ${pageUrl}`;
          addToCache(cacheKey, { data: result, timestamp: now });
          return result;
        }
      }

      const result = `「${searchTerm}」の情報を取得できませんでした。`;
      addToCache(cacheKey, { data: result, timestamp: now });
      return result;
    } catch (error) {
      console.error('Wikipedia検索エラー:', error.message);
      return `Wikipedia検索中にエラーが発生しました: ${error.message}`;
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

      if (bio) {
        result += `[info][title]私について[/title]${bio}[/info]\n\n`;
      }

      if (status) {
        result += `[info][title]私が取り組んでいること[/title]${status}[/info]\n\n`;
      }

      if (!bio && !status) {
        result = `[info][title]Scratchユーザー情報[/title]ユーザー名: ${username}\nプロフィール情報がありません。[/info]\n\n`;
      }

      result += `ユーザーページ: ${userLink}`;

      return result;
    } catch (error) {
      if (error.response?.status === 404) {
        return `「${username}」というScratchユーザーは見つかりませんでした。`;
      }
      return `Scratchユーザー情報の取得中に予期せぬエラーが発生しました。`;
    }
  }

  static async getScratchProjectInfo(projectId) {
    try {
      await apiCallLimiter();
      const response = await axios.get(`https://api.scratch.mit.edu/projects/${projectId}`);
      const data = response.data;
      if (!data || !data.title) {
        return 'プロジェクトが見つかりませんでした。';
      }
      const url = `https://scratch.mit.edu/projects/${projectId}/`;
      return `[info][title]Scratchプロジェクト情報[/title]タイトル: ${data.title}\n作者: ${data.author.username}\n説明: ${data.description || '説明なし'}\nURL: ${url}[/info]`;
    } catch (error) {
      return 'Scratchプロジェクト情報の取得中にエラーが発生しました。';
    }
  }

  // 追加: 天気予報取得（気象API: weather.tsukumijima.net）
  static async getWeatherForecast(cityCode) {
    try {
      const url = `${WEATHER_API_BASE}/${cityCode}.json`;
      const response = await axios.get(url, { timeout: 10000 });
      return response.data || null;
    } catch (error) {
      console.error(`天気予報取得エラー (${cityCode}):`, error.message);
      return null;
    }
  }

  // 歌詞取得機能
  static async getLyrics(url) {
    try {
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const $ = cheerio.load(response.data);
      let title = '';
      let lyrics = '';

      if (url.includes('utaten.com')) {
        // うたてんの処理
        const titleMain = $('h2.newLyricTitle__main').text().trim();
        const titleAfter = $('span.newLyricTitle_afterTxt').text().trim();
        title = titleMain.replace(titleAfter, '').trim();

        // ルビ（<span class="rt">）を削除
        $('div.hiragana span.rt').remove();
        
        // 歌詞取得
        lyrics = $('div.hiragana').html() || '';
        
        // HTMLタグを改行に変換
        lyrics = lyrics.replace(/<br\s*\/?>/gi, '\n')
                      .replace(/<[^>]+>/g, '')
                      .trim();

      } else if (url.includes('uta-net.com')) {
        // 歌ネットの処理
        title = $('h2.ms-2.ms-md-3.kashi-title').text().trim();
        
        // 歌詞取得
        lyrics = $('div#kashi_area[itemprop="text"]').html() || '';
        
        // HTMLタグを改行に変換
        lyrics = lyrics.replace(/<br\s*\/?>/gi, '\n')
                      .replace(/<[^>]+>/g, '')
                      .trim();
      } else {
        return '対応していないURLです。utaten.comまたはuta-net.comのURLを指定してください。';
      }

      if (!title || !lyrics) {
        return '歌詞の取得に失敗しました。URLを確認してください。';
      }

      return `[info][title]${title}の歌詞[/title]${lyrics}[/info]`;
    } catch (error) {
      console.error('歌詞取得エラー:', error.message);
      return `歌詞の取得中にエラーが発生しました: ${error.message}`;
    }
  }

  static async initializeMessageCount(roomId) {
    try {
      console.log(`ルーム ${roomId} のメッセージカウントを初期化中...`);
      const messages = await this.getRoomMessages(roomId);

      const now = new Date();
      const jstDate = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
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

      const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);
      console.log(`ルーム ${roomId} 初期化完了: ${totalCount}件のメッセージ`);

      return counts;
    } catch (error) {
      console.error(`ルーム ${roomId} の初期化エラー:`, error.message);
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
      console.error(`メッセージ取得エラー (${roomId}):`, error.message);
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
      console.error(`メッセージ取得エラー (${roomId}/${messageId}):`, error.message);
      return null;
    }
  }

  static async getLatestEarthquakeInfo() {
    try {
      const response = await axios.get('https://api.p2pquake.net/v2/history?codes=551&limit=1');
      const data = response.data;

      if (!data || data.length === 0) {
        return null;
      }

      const earthquake = data[0];

      if (!earthquake.earthquake || earthquake.earthquake.maxScale < 30) {
        return null;
      }

      return {
        id: earthquake.id,
        time: earthquake.earthquake.time,
        hypocenter: earthquake.earthquake.hypocenter && earthquake.earthquake.hypocenter.name ? earthquake.earthquake.hypocenter.name : null,
        magnitude: earthquake.earthquake.hypocenter ? earthquake.earthquake.hypocenter.magnitude : null,
        maxScale: earthquake.earthquake.maxScale
      };
    } catch (error) {
      console.error('地震情報取得エラー:', error.message);
      return null;
    }
  }

  static async notifyEarthquake(earthquakeInfo, isTest = false) {
    try {
      const scaleMap = {
        10: '1',
        20: '2',
        30: '3',
        40: '4',
        45: '5弱',
        50: '5強',
        55: '6弱',
        60: '6強',
        70: '7'
      };
      const scale = scaleMap[earthquakeInfo.maxScale] || (earthquakeInfo.maxScale / 10);

      const earthquakeDate = new Date(earthquakeInfo.time);
      const jstDateStr = earthquakeDate.toLocaleString("ja-JP", { 
        timeZone: "Asia/Tokyo",
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });

      const parts = jstDateStr.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
      if (!parts) {
        console.error('日時のパースに失敗:', jstDateStr);
        return;
      }

      const [, year, month, day, hours, minutes] = parts;

      const title = isTest ? '地震情報-テスト' : '地震情報';
      const magnitudeText = (earthquakeInfo.magnitude === null || earthquakeInfo.magnitude === -1 || earthquakeInfo.magnitude === undefined) ? '調査中' : earthquakeInfo.magnitude;

      let message;
      if (!earthquakeInfo.hypocenter || earthquakeInfo.hypocenter === '' || earthquakeInfo.hypocenter === '不明') {
        message = `[info][title]${title}[/title]${year}年${month}月${day}日 ${hours}:${minutes} に震度${scale}の地震が発生しました。\nマグニチュード: ${magnitudeText}。[/info][...]
      } else {
        message = `[info][title]${title}[/title]${year}年${month}月${day}日 ${hours}:${minutes} に ${earthquakeInfo.hypocenter} を中心とする震度${scale}の地震が発生しました。\n�[...]
      }

      for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
        try {
          await this.sendChatworkMessage(roomId, message);
          console.log(`地震情報送信完了: ルーム ${roomId}`);
        } catch (error) {
          console.error(`ルーム ${roomId} への地震情報送信エラー:`, error.message);
        }
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
      if (error.response?.status === 404) {
        return { error: 'not_found' };
      }
      console.error(`ルーム情報取得エラー (${roomId}):`, error.message);
      return { error: 'unknown' };
    }
  }

  static async getRoomMembersWithToken(roomId, apiToken) {
    await apiCallLimiter();
    try {
      const response = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}/members`, {
        headers: { 'X-ChatWorkToken': apiToken }
      });
      return response.data.map(member => ({
        account_id: member.account_id,
        name: member.name,
        role: member.role
      }));
    } catch (error) {
      console.error(`メンバー取得エラー (${roomId}):`, error.message);
      return [];
    }
  }

  static async getAllTodayMessages(roomId) {
    try {
      const now = new Date();
      const jstDate = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
      const todayStart = new Date(jstDate.getFullYear(), jstDate.getMonth(), jstDate.getDate(), 0, 0, 0);
      const todayStartTimestamp = Math.floor(todayStart.getTime() / 1000);

      const allMessagesMap = new Map();
      let loopCount = 0;
      const MAX_LOOPS = 50;
      let lastMessageId = null;
      let continueFetching = true;

      while (continueFetching && loopCount < MAX_LOOPS) {
        loopCount++;
        await apiCallLimiter();

        const params = lastMessageId ? { force: lastMessageId } : { force: 1 };
        let response;
        try {
          response = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}/messages`, {
            headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN },
            params
          });
        } catch (err) {
          console.error(`getAllTodayMessages API error (${roomId}):`, err.message);
          break;
        }

        const messages = response.data || [];
        if (!messages || messages.length === 0) {
          break;
        }

        for (const msg of messages) {
          if (!msg || !msg.message_id) continue;
          if (!allMessagesMap.has(String(msg.message_id))) {
            allMessagesMap.set(String(msg.message_id), msg);
          }
        }

        const lastMsg = messages[messages.length - 1];
        if (lastMsg && typeof lastMsg.send_time === 'number' && lastMsg.send_time < todayStartTimestamp) {
          break;
        }

        const newLastId = messages[messages.length - 1] ? String(messages[messages.length - 1].message_id) : null;
        if (!newLastId || newLastId === lastMessageId) {
          break;
        }
        lastMessageId = newLastId;

        await new Promise(r => setTimeout(r, 200));
      }

      const todayMessages = Array.from(allMessagesMap.values()).filter(m => typeof m.send_time === 'number' && m.send_time >= todayStartTimestamp);
      todayMessages.sort((a, b) => b.send_time - a.send_time);

      return todayMessages;
    } catch (error) {
      console.error(`getAllTodayMessages エラー (${roomId}):`, error.message);
      return [];
    }
  }

  // ルーム参加チェック
  static async isRoomMember(roomId) {
    try {
      await apiCallLimiter();
      await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}`, {
        headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
      });
      return true;
    } catch (error) {
      if (error.response?.status === 404) {
        return false;
      }
      return false;
    }
  }
}

// WebHookメッセージ処理クラス
class WebHookMessageProcessor {
  static async saveWebhookToDatabase(webhookData) {
    try {
      const roomId = webhookData.room_id;
      const messageId = webhookData.message_id;
      const accountId = webhookData.account_id;
      const accountName = webhookData.account?.name || null;
      const body = webhookData.body || '';
      const sendTime = webhookData.send_time;
      const updateTime = webhookData.update_time || null;
      const webhookEventType = webhookData.webhook_event_type || 'message_created';
      const webhookEventTime = webhookData.webhook_event_time || null;

      await pool.query(`
        INSERT INTO webhooks (
          room_id, message_id, account_id, account_name, body,
          send_time, update_time, webhook_event_type, webhook_event_time
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (message_id) DO NOTHING
      `, [
        roomId, messageId, accountId, accountName, body,
        sendTime, updateTime, webhookEventType, webhookEventTime
      ]);

      console.log(`WebHook保存: ルーム ${roomId}, メッセージID ${messageId}`);
    } catch (error) {
      console.error('WebHook保存エラー:', error.message);
    }
  }

  static async processWebHookMessage(webhookData) {
    try {
      await this.saveWebhookToDatabase(webhookData);

      const roomId = webhookData.room_id;
      const messageBody = webhookData.body;
      const messageId = webhookData.message_id;
      const accountId = webhookData.account_id;
      const account = webhookData.account || null;

      let userName = '';
      if (account && account.name) {
        userName = account.name;
      } else if (accountId) {
        userName = `ID:${accountId}`;
      }

      if (!roomId || !accountId || !messageBody) {
        console.log('不完全なWebHookデータ:', webhookData);
        return;
      }

      this.updateMessageCount(roomId, accountId);

      console.log(`ログ送信チェック: sourceRoomId=${roomId}, LOG_ROOM_ID=${LOG_ROOM_ID}`);
      await ChatworkBotUtils.sendLogToChatwork(userName, messageBody, roomId);

      let currentMembers = [];
      let isSenderAdmin = true;
      const isDirectChat = webhookData.room_type === 'direct';

      if (!isDirectChat) {
        currentMembers = await ChatworkBotUtils.getChatworkMembers(roomId);
        isSenderAdmin = this.isUserAdmin(accountId, currentMembers);
      }

      await this.handleCommands(
        roomId,
        messageId,
        accountId,
        (messageBody || '').trim(),
        isSenderAdmin,
        isDirectChat,
        currentMembers
      );
    } catch (error) {
      console.error('WebHookメッセージ処理エラー:', error.message);
    }
  }

  static updateMessageCount(roomId, accountId) {
    try {
      const now = new Date();
      const jstDate = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
      const todayDateOnly = jstDate.toISOString().split('T')[0];

      const lastResetDate = memoryStorage.roomResetDates.get(roomId);

      if (lastResetDate !== todayDateOnly) {
        memoryStorage.messageCounts.set(roomId, {});
        memoryStorage.roomResetDates.set(roomId, todayDateOnly);
        console.log(`ルーム ${roomId} のメッセージカウントをリセットしました (${todayDateOnly})`);
      }

      let roomCounts = memoryStorage.messageCounts.get(roomId) || {};
      roomCounts[accountId] = (roomCounts[accountId] || 0) + 1;
      memoryStorage.messageCounts.set(roomId, roomCounts);
    } catch (error) {
      console.error('メッセージカウント更新エラー:', error.message);
    }
  }

  static async handleCommands(roomId, messageId, accountId, messageBody, isSenderAdmin, isDirectChat, currentMembers) {
    if (!isDirectChat && messageBody.includes('[toall]') && !isSenderAdmin) {
      console.log(`[toall]を検出した非管理者: ${accountId} in room ${roomId}`);
    }

    // 歌詞取得コマンド
    if (messageBody.startsWith('/lyric ')) {
      const url = messageBody.substring('/lyric '.length).trim();
      if (url && (url.includes('utaten.com') || url.includes('uta-net.com'))) {
        const lyrics = await ChatworkBotUtils.getLyrics(url);
        const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}]${lyrics}`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, replyMessage);
      } else {
        const errorMessage = `[rp aid=${accountId} to=${roomId}-${messageId}]使用方法: /lyric {utaten.comまたはuta-net.comのURL}`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, errorMessage);
      }
      return;
    }

    if (messageBody === 'おみくじ') {
      const omikujiResult = ChatworkBotUtils.drawOmikuji(isSenderAdmin);
      const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}][pname:${accountId}]さん、[info][title]おみくじ[/title]おみくじの結果は…\n\n${omikujiResult}\n\nです！[/i[...]
      await ChatworkBotUtils.sendChatworkMessage(roomId, replyMessage);
    }

    if (!isDirectChat && !isSenderAdmin) {
      const emojiCount = ChatworkBotUtils.countChatworkEmojis(messageBody);
      if (emojiCount >= 50) {
        const warningMessage = `[To:${accountId}][pname:${accountId}]さん、Chatwork絵文字を${emojiCount}個送信されました。適度な使用をお願いします。`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, warningMessage);
      }
    }

    if (messageBody === '/yes-or-no') {
      const answer = await ChatworkBotUtils.getYesOrNoAnswer();
      const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}][pname:${accountId}]さん、答えは「${answer}」です！`;
      await ChatworkBotUtils.sendChatworkMessage(roomId, replyMessage);
    }

    if (messageBody.startsWith('/wiki/')) {
      const searchTerm = messageBody.substring('/wiki/'.length).trim();
      if (searchTerm) {
        const wikipediaSummary = await ChatworkBotUtils.getWikipediaSummary(searchTerm);
        const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}][pname:${accountId}]さん、Wikipediaの検索結果です。\n\n${wikipediaSummary}`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, replyMessage);
      }
    }

    if (messageBody.startsWith('/info/')) {
      const targetRoomId = messageBody.substring('/info/'.length).trim();

      if (!targetRoomId || !INFO_API_TOKEN) {
        const errorMsg = !INFO_API_TOKEN
          ? 'INFO_API_TOKENが設定されていません。'
          : 'ルームIDを指定してください。';
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]${errorMsg}`);
        return;
      }

      try {
        const roomInfo = await ChatworkBotUtils.getRoomInfoWithToken(targetRoomId, INFO_API_TOKEN);

        if (roomInfo.error === 'not_found') {
          await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]存在しないルームです。`);
          return;
        }

        if (roomInfo.error) {
          await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]ルーム情報の取得に失敗しました。`);
          return;
        }

        const members = await ChatworkBotUtils.getRoomMembersWithToken(targetRoomId, INFO_API_TOKEN);
        const isYuyuyuMember = members.some(m => m.account_id === parseInt(YUYUYU_ACCOUNT_ID));

        if (!isYuyuyuMember) {
          await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]ゆゆゆの本垢が参加していません。`);
          return;
        }

        const roomName = roomInfo.name;
        const memberCount = members.length;
        const adminCount = members.filter(m => m.role === 'admin').length;
        const fileCount = roomInfo.file_num || 0;
        const messageCount = roomInfo.message_num || 0;
        const iconPath = roomInfo.icon_path || '';

        let iconLink = 'なし';
        if (iconPath) {
          if (iconPath.startsWith('http')) {
            iconLink = iconPath;
          } else {
            iconLink = `https://appdata.chatwork.com${iconPath}`;
          }
        }

        const admins = members.filter(m => m.role === 'admin');
        let adminList = '';
        if (admins.length > 0) {
          adminList = admins.map(admin => `[picon:${admin.account_id}]`).join(' ');
        } else {
          adminList = 'なし';
        }

        const infoMessage = `[rp aid=${accountId} to=${roomId}-${messageId}][info][title]${roomName}の情報[/title]部屋名：${roomName}\nメンバー数：${memberCount}人\n管理者数：${admi[...]
        await ChatworkBotUtils.sendChatworkMessage(roomId, infoMessage);
      } catch (error) {
        console.error('ルーム情報取得エラー:', error.message);
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]ルーム情報の取得中にエラーが発生しました。`);
      }
      return;
    }

    if (messageBody.startsWith('/scratch-user/')) {
      const username = messageBody.substring('/scratch-user/'.length).trim();
      if (username) {
        const userStats = await ChatworkBotUtils.getScratchUserStats(username);
        const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}][pname:${accountId}]さん、Scratchユーザー「${username}」の情報です。\n\n${userStats}`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, replyMessage);
      }
    }

    if (messageBody.startsWith('/scratch-project/')) {
      const projectId = messageBody.substring('/scratch-project/'.length).trim();
      if (projectId) {
        const projectInfo = await ChatworkBotUtils.getScratchProjectInfo(projectId);
        const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}][pname:${accountId}]さん、Scratchプロジェクト「${projectId}」の情報です。\n\n${projectInfo}`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, replyMessage);
      }
    }

    if (messageBody === '/today') {
      const now = new Date();
      const jstDate = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
      const todayFormatted = jstDate.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
      let messageContent = `[info][title]今日の情報[/title]今日は${todayFormatted}だよ！`;
      const events = await getTodaysEventsFromJson();
      if (events.length > 0) {
        events.forEach(event => {
          messageContent += `\n今日は${event}だよ！`;
        });
      } else {
        messageContent += `\n今日は特に登録されたイベントはないみたい。`;
      }
      messageContent += `[/info]`;
      const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}][pname:${accountId}]さん、\n\n${messageContent}`;
      await ChatworkBotUtils.sendChatworkMessage(roomId, replyMessage);
    }

    // /weather コマンド：午後6時前は今日の天気、午後6時以降は明日の天気を返信
    if (messageBody === '/weather') {
      try {
        const now = new Date();
        const jstNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
        const hour = jstNow.getHours();
        const isTomorrow = hour >= 18; // 18時以降は明日の天気
        const label = isTomorrow ? '明日の天気予報' : '今日の天気予報';

        for (const region of WEATHER_REGIONS) {
          try {
            const data = await ChatworkBotUtils.getWeatherForecast(region.code);
            if (!data) {
              console.error(`天気データ取得失敗: ${region.name} (${region.code})`);
              continue;
            }

            const forecastIndex = isTomorrow ? 1 : 0;
            const forecast = (data.forecasts && data.forecasts[forecastIndex]) ? data.forecasts[forecastIndex] : (data.forecasts ? data.forecasts[0] : null);

            const telop = forecast?.telop || '不明';
            const maxTemp = forecast?.temperature?.max?.celsius ?? null;
            const minTemp = forecast?.temperature?.min?.celsius ?? null;
            const description = data.description?.text || (forecast?.detail || '');

            let message = `[info][title]${region.name}の${label}[/title]\n`;
            message += `天気　　　：${telop}\n`;
            message += `最高気温　：${maxTemp !== null ? `${maxTemp}℃` : '不明'}\n`;
            if (minTemp !== null && minTemp !== undefined) {
              message += `最低気温　：${minTemp}℃\n`;
            }
            message += `天気概況文：${description}\n\n[/info]`;

            await ChatworkBotUtils.sendChatworkMessage(roomId, message);
          } catch (errRegion) {
            console.error(`/weather: ${region.name} の処理中にエラー:`, errRegion.message);
          }
        }
      } catch (err) {
        console.error('/weather 処理エラー:', err.message);
      }
      return;
    }

    if (!isDirectChat && messageBody === '/member') {
      if (currentMembers.length > 0) {
        let reply = '[info][title]メンバー一覧[/title]\n';
        currentMembers.forEach(member => {
          reply += `・${member.name} (${member.role})\n`;
        });
        reply += '[/info]';
        await ChatworkBotUtils.sendChatworkMessage(roomId, reply);
      }
    }

    if (!isDirectChat && messageBody === '/member-name') {
      if (currentMembers.length > 0) {
        const names = currentMembers.map(m => m.name).join(', ');
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[info][title]メンバー名一覧[/title]\n${names}[/info]`);
      }
    }

    if (!isDirectChat && messageBody === '/info') {
      try {
        const roomInfo = await ChatworkBotUtils.getRoomInfo(roomId);

        if (!roomInfo) {
          await ChatworkBotUtils.sendChatworkMessage(roomId, 'ルーム情報の取得に失敗しました。');
          return;
        }

        const roomName = roomInfo.name;
        const memberCount = currentMembers.length;
        const adminCount = currentMembers.filter(m => m.role === 'admin').length;
        const fileCount = roomInfo.file_num || 0;
        const messageCount = roomInfo.message_num || 0;
        const iconPath = roomInfo.icon_path || '';

        const messages = await ChatworkBotUtils.getRoomMessages(roomId);
        let messageLink = 'なし';
        if (messages && messages.length > 0) {
          const latestMessageId = messages[0].message_id;
          messageLink = `https://www.chatwork.com/#!rid${roomId}-${latestMessageId}`;
        }

        let iconLink = 'なし';
        if (iconPath) {
          if (iconPath.startsWith('http')) {
            iconLink = iconPath;
          } else {
            iconLink = `https://appdata.chatwork.com${iconPath}`;
          }
        }

        const admins = currentMembers.filter(m => m.role === 'admin');
        let adminList = '';
        if (admins.length > 0) {
          adminList = admins.map(admin => `[picon:${admin.account_id}]`).join(' ');
        } else {
          adminList = 'なし';
        }

        const infoMessage = `[info][title]${roomName}の情報[/title]部屋名：${roomName}\nメンバー数：${memberCount}人\n管理者数：${adminCount}人\nルームID：${roomId}\nファイ�[...]

        await ChatworkBotUtils.sendChatworkMessage(roomId, infoMessage);
      } catch (error) {
        console.error('ルーム情報取得エラー:', error.message);
        await ChatworkBotUtils.sendChatworkMessage(roomId, 'ルーム情報の取得中にエラーが発生しました。');
      }
    }

    if (messageBody === '/romera') {
      try {
        console.log(`ルーム ${roomId} のランキングを作成中...`);
        
        let counts = memoryStorage.messageCounts.get(roomId) || {};

        const ranking = Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([accountId, count], index) => ({
            rank: index + 1,
            accountId,
            count
          }));

        const totalCount = ranking.reduce((sum, item) => sum + item.count, 0);

        let rankingMessage = '[info][title]メッセージ数ランキング[/title]\n';
        if (ranking.length === 0) {
          rankingMessage += '今日のメッセージはまだありません。\n';
        } else {
          ranking.forEach((item, index) => {
            rankingMessage += `${item.rank}位：[piconname:${item.accountId}] ${item.count}コメ`;
            if (index < ranking.length - 1) {
              rankingMessage += '\n[hr]';
            }
            rankingMessage += '\n';
          });
        }
        rankingMessage += `\n合計：${totalCount}コメ\n(botを含む)[/info]`;

        await ChatworkBotUtils.sendChatworkMessage(roomId, rankingMessage);
      } catch (error) {
        console.error('ランキング取得エラー:', error.message);
        await ChatworkBotUtils.sendChatworkMessage(roomId, 'ランキングの取得中にエラーが発生しました。');
      }
    }

    if (messageBody === '/komekasegi') {
      const messages = [
        'コメ稼ぎだお',
        '過疎だね',
        '静かすぎて風の音が聞こえる',
        'みんな寝落ちした？',
        'ここ、無人島かな？',
        '今日も平和だね〜',
        '誰か生きてる？',
        '砂漠のオアシス状態',
        'コメントが凍結してる!?',
        'しーん……',
        'この空気、逆に好き',
        '時が止まったみたい',
        '過疎 is 神',
        '電波届いてるよね？',
        'こっそり独り言タイム',
        'エコー返ってくる気がする',
        '幽霊さん、いますか〜？'
      ];

      for (let i = 0; i < 10; i++) {
        const randomMessage = messages[Math.floor(Math.random() * messages.length)];
        await ChatworkBotUtils.sendChatworkMessage(roomId, randomMessage);

        if (i < 9) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    if (!isDirectChat && messageBody === '/disself') {
      try {
        const currentUser = currentMembers.find(m => m.account_id === accountId);

        if (!currentUser) {
          return;
        }

        const currentRole = currentUser.role;

        if (currentRole === 'admin') {
          const admins = currentMembers.filter(m => m.role === 'admin' && m.account_id !== accountId).map(m => m.account_id);
          const members = currentMembers.filter(m => m.role === 'member').map(m => m.account_id);
          const readonly = currentMembers.filter(m => m.role === 'readonly').map(m => m.account_id);

          members.push(accountId);

          const params = new URLSearchParams();
          if (admins.length > 0) params.append('members_admin_ids', admins.join(','));
          if (members.length > 0) params.append('members_member_ids', members.join(','));
          if (readonly.length > 0) params.append('members_readonly_ids', readonly.join(','));

          await apiCallLimiter();
          await axios.put(
            `https://api.chatwork.com/v2/rooms/${roomId}/members`,
            params,
            { headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN } }
          );

          console.log(`${accountId} を管理者からメンバーに降格しました（ルーム ${roomId}）`);
        } else if (currentRole === 'member') {
          const admins = currentMembers.filter(m => m.role === 'admin').map(m => m.account_id);
          const members = currentMembers.filter(m => m.role === 'member' && m.account_id !== accountId).map(m => m.account_id);
          const readonly = currentMembers.filter(m => m.role === 'readonly').map(m => m.account_id);

          readonly.push(accountId);

          const params = new URLSearchParams();
          if (admins.length > 0) params.append('members_admin_ids', admins.join(','));
          if (members.length > 0) params.append('members_member_ids', members.join(','));
          if (readonly.length > 0) params.append('members_readonly_ids', readonly.join(','));

          await apiCallLimiter();
          await axios.put(
            `https://api.chatwork.com/v2/rooms/${roomId}/members`,
            params,
            { headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN } }
          );

          console.log(`${accountId} をメンバーから閲覧のみに降格しました（ルーム ${roomId}）`);
        }
      } catch (error) {
        console.error('権限変更エラー:', error.message);
      }
      return;
    }

    const responses = {
      'はんせい': `[To:10911090] なかよし\n[pname:${accountId}]に呼ばれてるよ！`,
      'ゆゆゆ': `[To:10544705] ゆゆゆ\n[pname:${accountId}]に呼ばれてるよ！`,
      'からめり': `[To:10337719] からめり\n[pname:${accountId}]に呼ばれてるよ！`,
      'いろいろあぷり': `https://shiratama-kotone.github.io/any-app/`,
      '喘げ': `...っ♡///`,
      'おやすみ': `おやすみなさい！[pname:${accountId}]！`,
      'おはよう': `[pname:${accountId}] おはよう！`,
      '/test': `アカウントID:${accountId}`,
      'プロセカやってくる': `[preview id=1864425247 ht=130]`,
      'おっ': `ぱい`,
      'せっ': `くす`,
      '精': `子`,
      '114': `514`,
      'ちん': `ちんㅤ`,
      '野獣': `やりますねぇ！`,
      'こ↑': `こ↓`,
      '富士山': `3776m!`,
      'TOALL': `[toall...すると思った？`,
      'botのコードください': `https://github.com/shiratama-kotone/cw-bot`,
      '1+1=': `1!`,
      'トイレいってくる': `漏らさないでねー`,
      'からめりは': `エロ画像マニア！`,
      'たまごは': `人外ナー！`,
      'ゆゆゆは': `かわいい．．．はず`,
      'はんせいは': `かっこいい！`,
      'プロセカ公式Youtube': `https://www.youtube.com/@pj_sekai_colorfulstage`,
      '6': `9`,
      'Git': `hub`,
      '初音': `ミク`,
      '鏡音': `リン`,
      '巡音': `ルカ`,
      'MEI': `KO`,
      'KAI': `TO`,
      '星乃': `一歌`,
      '天馬': `咲希 または 司`,
      '望月': `穂波`,
      '日野森': `志歩 または 雫`,
      '花里': `みのり`,
      '桐谷': `遥`,
      '桃井': `愛莉`,
      '小豆沢': `こはね`,
      '白石': `杏`,
      '東雲': `絵名 または 彰人`,
      '青柳': `冬弥`,
      '鳳': `えむ`,
      '草薙': `寧々`,
      '神代': `類`,
      '宵崎': `奏`,
      '朝比奈': `まふゆ`,
      '暁山': `瑞希 または 優希`,
      '高木': `未羽`,
      '吉崎': `花乃 または 葉太`,
      '高坂': `朔`,
      '真堂': `良樹`,
      '日暮': `アリサ`,
      '山下': `真里奈`,
      '早川': `ななみ`,
      '内山': `唯奈`,
      '斎藤': `彩香`,
      '長谷川': `里帆`,
      '有澤': `日菜子`,
      '柊': `マグネタイト`,
      'ジャン': `ライリー`,
      '雪平': `実篤`,
      '夏野': `二葉`,
    };
    if (responses[messageBody]) {
      await ChatworkBotUtils.sendChatworkMessage(roomId, responses[messageBody]);
    }
  }

  static isUserAdmin(accountId, allMembers) {
    const user = allMembers.find(member => member.account_id === accountId);
    return user && user.role === 'admin';
  }
}

// Express.jsのルート設定
app.use(express.json());

// WebHookエンドポイント
app.post('/webhook', async (req, res) => {
  try {
    console.log('WebHook受信:', JSON.stringify(req.body, null, 2));
    const webhookEvent = req.body.webhook_event || req.body;
    if (webhookEvent && webhookEvent.room_id) {
      await WebHookMessageProcessor.processWebHookMessage(webhookEvent);
      res.status(200).json({ status: 'success', message: 'WebHook processed' });
    } else {
      console.log('無効なWebHookデータ:', req.body);
      res.status(400).json({ error: 'Invalid webhook data' });
    }
  } catch (error) {
    console.error('WebHook処理エラー:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// メッセージ送信エンドポイント
app.get('/msg-post', async (req, res) => {
  try {
    const { roomid, msg } = req.query;

    if (!roomid || !msg) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'roomidとmsgパラメータが必要です' 
      });
    }

    // ルーム参加チェック
    const isMember = await ChatworkBotUtils.isRoomMember(roomid);
    
    if (!isMember) {
      return res.status(304).json({ 
        status: 'error', 
        message: 'ルームに参加していません' 
      });
    }

    // メッセージ送信
    const messageId = await ChatworkBotUtils.sendChatworkMessage(roomid, msg);
    
    if (messageId) {
      res.json({ 
        status: 'success', 
        message: 'メッセージを送信しました',
        messageId: messageId
      });
    } else {
      res.status(500).json({ 
        status: 'error', 
        message: 'メッセージ送信に失敗しました' 
      });
    }
  } catch (error) {
    console.error('メッセージ送信エラー:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ヘルスチェック
app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Chatwork Bot WebHook版 (全ルーム対応)',
    timestamp: new Date().toISOString(),
    mode: 'WebHook - All Rooms',
    storage: 'Memory',
    logRoom: LOG_ROOM_ID
  });
});

// 手動実行エンドポイント（テスト用）
app.post('/test-message', async (req, res) => {
  try {
    const { room_id, message_body, account_id, user_name } = req.body;
    if (!room_id || !message_body || !account_id || !user_name) {
      return res.status(400).json({ error: 'room_id, message_body, account_id, user_name are required' });
    }
    const testWebhookData = {
      room_id,
      account: { account_id, name: user_name },
      body: message_body,
      message_id: 'test_' + Date.now(),
      room_type: 'group'
    };
    await WebHookMessageProcessor.processWebHookMessage(testWebhookData);
    res.json({ status: 'success', message: 'Test message processed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 統計・管理用エンドポイント
app.get('/status', async (req, res) => {
  try {
    res.json({
      status: 'OK',
      mode: 'WebHook - All Rooms',
      storage: 'Memory',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      logRoomId: LOG_ROOM_ID,
      dayJsonUrl: DAY_JSON_URL,
      directChatRooms: DIRECT_CHAT_WITH_DATE_CHANGE,
      memoryUsage: {
        apiCacheSize: API_CACHE.size,
        lastSentDatesSize: memoryStorage.lastSentDates.size,
        lastEarthquakeId: memoryStorage.lastEarthquakeId
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// day.jsonテスト用エンドポイント
app.get('/test-day-events', async (req, res) => {
  try {
    const events = await getTodaysEventsFromJson();
    res.json({ status: 'success', todayEvents: events });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// day.json読み込みテスト
app.get('/load-day-json', async (req, res) => {
  try {
    const dayEvents = await loadDayEvents();
    res.json({ status: 'success', dayEvents });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// 地震情報テスト用エンドポイント
app.get('/eew-test:scale', async (req, res) => {
  try {
    const scale = parseInt(req.params.scale);

    if (isNaN(scale) || scale < 10 || scale > 70) {
      return res.status(400).json({
        status: 'error',
        message: '震度は10〜70の範囲で指定してください（10=震度1, 70=震度7）'
      });
    }

    const now = new Date();
    const testEarthquakeInfo = {
      id: `test_${Date.now()}`,
      time: now.toISOString(),
      hypocenter: 'テスト震源地',
      magnitude: null,
      maxScale: scale
    };

    await ChatworkBotUtils.notifyEarthquake(testEarthquakeInfo, true);

    res.json({
      status: 'success',
      message: 'テスト地震情報を送信しました',
      earthquakeInfo: testEarthquakeInfo
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Make it a Quote画像生成エンドポイント（外部API経由）
app.get('/miaq', async (req, res) => {
  try {
    const { 'u-name': username, 'd-name': displayName, text, avatar, color } = req.query;

    if (!text || !avatar) {
      return res.status(400).json({
        status: 'error',
        message: '必須パラメータが不足しています: text, avatar'
      });
    }

    const finalUsername = username || 'Anonymous';
    const finalDisplayName = displayName || username || 'Anonymous';
    const isColor = true;

    console.log('MIAQ画像生成リクエスト:', {
      username: finalUsername,
      displayName: finalDisplayName,
      text: (text || '').substring(0, 50),
      avatar: (avatar || '').substring(0, 50),
      color: isColor
    });

    if (!ChatworkBotUtils.generateQuoteImageFromAPI) {
      return res.status(500).json({ status: 'error', message: '画像生成機能が利用できません' });
    }

    const imageBuffer = await ChatworkBotUtils.generateQuoteImageFromAPI(
      finalUsername,
      finalDisplayName,
      text,
      avatar,
      isColor
    );

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', imageBuffer.length);
    res.send(imageBuffer);
  } catch (error) {
    console.error('MIAQ画像生成エラー:', error.message);
    res.status(500).json({
      status: 'error',
      message: '画像生成に失敗しました',
      error: error.message
    });
  }
});

// 追加: /msg-post エンドポイント（GET/POST）
// - GET  /msg-post?roomid={ルームID}&msg={メッセージ}
// - POST /msg-post  Content-Type: application/json  Body: { "roomid": "...", "msg": "..." }
// ボットが指定ルームに参加していない場合は 304 を返します
app.get('/msg-post', async (req, res) => {
  try {
    const roomId = (req.query.roomid || req.query.room_id || '').toString().trim();
    const message = (req.query.msg || req.query.message || '').toString();

    if (!roomId || !message) {
      return res.status(400).json({ status: 'error', message: 'roomid and msg query parameters are required' });
    }

    // 参加チェック
    const isMember = await ChatworkBotUtils.isRoomMember(roomId);
    if (!isMember) {
      // 要望どおり 304 を返す
      return res.status(304).json({ status: 'not_member', message: 'Bot is not a member of the specified room' });
    }

    const messageId = await ChatworkBotUtils.sendChatworkMessage(roomId, message);
    if (!messageId) {
      return res.status(502).json({ status: 'error', message: 'Failed to send message' });
    }

    return res.json({ status: 'success', room_id: roomId, message_id: messageId });
  } catch (error) {
    console.error('/msg-post GET error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/msg-post', async (req, res) => {
  try {
    const body = req.body || {};
    const roomId = (body.roomid || body.room_id || '').toString().trim();
    const message = (body.msg || body.message || '').toString();

    if (!roomId || !message) {
      return res.status(400).json({ status: 'error', message: 'JSON body must include roomid and msg (or room_id and message)' });
    }

    const isMember = await ChatworkBotUtils.isRoomMember(roomId);
    if (!isMember) {
      return res.status(304).json({ status: 'not_member', message: 'Bot is not a member of the specified room' });
    }

    const messageId = await ChatworkBotUtils.sendChatworkMessage(roomId, message);
    if (!messageId) {
      return res.status(502).json({ status: 'error', message: 'Failed to send message' });
    }

    return res.json({ status: 'success', room_id: roomId, message_id: messageId });
  } catch (error) {
    console.error('/msg-post POST error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

// 日付変更通知
async function sendDailyGreetingMessages() {
  try {
    console.log('日付変更通知の送信を開始します');

    const now = new Date();
    const jstDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const todayFormatted = jstDate.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
    const todayDateOnly = jstDate.toISOString().split('T')[0];

    for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
      try {
        const lastSentDate = memoryStorage.lastSentDates.get(roomId);
        if (lastSentDate !== todayDateOnly) {
          let message = `[info][title]日付変更！[/title]今日は${todayFormatted}だよ！`;
          const events = await getTodaysEventsFromJson();
          if (events.length > 0) {
            events.forEach(event => {
              message += `\n今日は${event}だよ！`;
            });
          }
          message += `[/info]`;
          const success = await ChatworkBotUtils.sendChatworkMessage(roomId, message);
          if (success) {
            memoryStorage.lastSentDates.set(roomId, todayDateOnly);
            console.log(`日付変更通知送信完了: ルーム ${roomId}`);

            console.log(`メッセージカウントをリセット: ルーム ${roomId}`);
            memoryStorage.messageCounts.set(roomId, {});
            memoryStorage.roomResetDates.set(roomId, todayDateOnly);
          }
        }
      } catch (error) {
        console.error(`ルーム ${roomId} への日付変更通知送信エラー:`, error.message);
      }
    }
  } catch (error) {
    console.error('日付変更通知処理エラー:', error.message);
  }
}

// 夜11時の通知
async function sendNightMessage() {
  try {
    console.log('夜11時の通知を送信します');
    const message = '11時だよ！\nおやすみの人はおやすみなさい！';

    for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
      try {
        await ChatworkBotUtils.sendChatworkMessage(roomId, message);
        console.log(`夜11時通知送信完了: ルーム ${roomId}`);
      } catch (error) {
        console.error(`ルーム ${roomId} への夜11時通知送信エラー:`, error.message);
      }
    }
  } catch (error) {
    console.error('夜11時通知処理エラー:', error.message);
  }
}

// 23:59にランキングを送信
async function sendDailyRanking() {
  try {
    console.log('今日のランキングを送信します');

    for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
      try {
        console.log(`ルーム ${roomId} のランキングを作成中...`);

        const messages = await ChatworkBotUtils.getAllTodayMessages(roomId);

        const counts = {};
        messages.forEach(msg => {
          const accId = msg.account && msg.account.account_id ? msg.account.account_id : null;
          if (accId) counts[accId] = (counts[accId] || 0) + 1;
        });

        memoryStorage.messageCounts.set(roomId, counts);

        const now = new Date();
        const jstDate = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
        memoryStorage.roomResetDates.set(roomId, jstDate.toISOString().split('T')[0]);

        const ranking = Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([accountId, count], index) => ({
            rank: index + 1,
            accountId,
            count
          }));

        const totalCount = ranking.reduce((sum, item) => sum + item.count, 0);

        let rankingMessage = '今日のコメ数ランキングだよ！\n[info][title]メッセージ数ランキング[/title]\n';
        if (ranking.length === 0) {
          rankingMessage += '今日のメッセージはまだありません。\n';
        } else {
          ranking.forEach((item, index) => {
            rankingMessage += `${item.rank}位：[piconname:${item.accountId}] ${item.count}コメ`;
            if (index < ranking.length - 1) {
              rankingMessage += '\n[hr]';
            }
            rankingMessage += '\n';
          });
        }
        rankingMessage += `\n合計：${totalCount}コメ\n(botを含む)[/info]`;

        await ChatworkBotUtils.sendChatworkMessage(roomId, rankingMessage);
        console.log(`ランキング送信完了: ルーム ${roomId}`);
      } catch (error) {
        console.error(`ルーム ${roomId} へのランキング送信エラー:`, error.message);
      }
    }
  } catch (error) {
    console.error('ランキング送信処理エラー:', error.message);
  }
}

// 23:55に日付変更前のランキングを送信
async function sendPreMidnightRanking() {
  try {
    console.log('日付変更前 (23:55) のランキングを送信します');

    for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
      try {
        console.log(`ルーム ${roomId} の事前ランキングを作成中...`);

        const messages = await ChatworkBotUtils.getAllTodayMessages(roomId);

        const counts = {};
        messages.forEach(msg => {
          const accId = msg.account && msg.account.account_id ? msg.account.account_id : null;
          if (accId) counts[accId] = (counts[accId] || 0) + 1;
        });

        memoryStorage.messageCounts.set(roomId, counts);

        const ranking = Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([accountId, count], index) => ({
            rank: index + 1,
            accountId,
            count
          }));

        const totalCount = ranking.reduce((sum, item) => sum + item.count, 0);

        let rankingMessage = '[info][title]日付変更前ランキング（23:55）[/title]\n';
        if (ranking.length === 0) {
          rankingMessage += '今日のメッセージはまだありません。\n';
        } else {
          ranking.forEach((item, index) => {
            rankingMessage += `${item.rank}位：[piconname:${item.accountId}] ${item.count}コメ`;
            if (index < ranking.length - 1) rankingMessage += '\n[hr]';
            rankingMessage += '\n';
          });
        }
        rankingMessage += `\n合計：${totalCount}コメ\n(botを含む)[/info]`;

        await ChatworkBotUtils.sendChatworkMessage(roomId, rankingMessage);
        console.log(`事前ランキング送信完了: ルーム ${roomId}`);
      } catch (error) {
        console.error(`ルーム ${roomId} への事前ランキング送信エラー:`, error.message);
      }
    }
  } catch (error) {
    console.error('事前ランキング送信処理エラー:', error.message);
  }
}

// 朝6時の通知
async function sendMorningMessage() {
  try {
    console.log('朝6時の通知を送信します');
    const message = 'みんなおはよう！！';

    for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
      try {
        await ChatworkBotUtils.sendChatworkMessage(roomId, message);
        console.log(`朝6時通知送信完了: ルーム ${roomId}`);
      } catch (error) {
        console.error(`ルーム ${roomId} への朝6時通知送信エラー:`, error.message);
      }
    }
  } catch (error) {
    console.error('朝6時通知処理エラー:', error.message);
  }
}

// 追加: 天気予報を整形して送信する関数
async function sendWeather(isTomorrow = false) {
  try {
    const label = isTomorrow ? '明日の天気予報' : '今日の天気予報';
    console.log(`${label}を送信します (isTomorrow=${isTomorrow})`);

    for (const region of WEATHER_REGIONS) {
      try {
        const data = await ChatworkBotUtils.getWeatherForecast(region.code);
        if (!data) {
          console.error(`天気データが取得できませんでした: ${region.name} (${region.code})`);
          continue;
        }

        // forecasts 配列の 0 が今日、1 が明日
        const forecastIndex = isTomorrow ? 1 : 0;
        const forecast = (data.forecasts && data.forecasts[forecastIndex]) ? data.forecasts[forecastIndex] : (data.forecasts ? data.forecasts[0] : null);

        const telop = forecast?.telop || '不明';
        const maxTemp = forecast?.temperature?.max?.celsius ?? null;
        const minTemp = forecast?.temperature?.min?.celsius ?? null;
        // 天気概況文は data.description.text を優先
        const description = data.description?.text || (forecast?.detail || '');

        // 指定のフォーマットに従ってメッセージ作成
        let message = `[info][title]${region.name}の${label}[/title]\n`;
        message += `天気　　　：${telop}\n`;
        message += `最高気温　：${maxTemp !== null ? `${maxTemp}℃` : '不明'}\n`;
        if (minTemp !== null && minTemp !== undefined) {
          // 最低気温が null のときは行を削除する（指定要件）
          message += `最低気温　：${minTemp}℃\n`;
        }
        message += `天気概況文：${description}\n\n[/info]`;

        // 地域ごとに別メッセージで、各指定ルームへ送信
        for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
          try {
            await ChatworkBotUtils.sendChatworkMessage(roomId, message);
            console.log(`${region.name} の天気を送信しました -> ルーム ${roomId}`);
          } catch (err) {
            console.error(`${region.name} の天気送信エラー (ルーム ${roomId}):`, err.message);
          }
        }
      } catch (err) {
        console.error(`地域 ${region.name} の天気処理中にエラー:`, err.message);
      }
    }
  } catch (error) {
    console.error('天気送信処理エラー:', error.message);
  }
}

// 地震情報チェック（1分ごと）
async function checkEarthquakeInfo() {
  try {
    const earthquakeInfo = await ChatworkBotUtils.getLatestEarthquakeInfo();

    if (earthquakeInfo && earthquakeInfo.id !== memoryStorage.lastEarthquakeId) {
      console.log('新しい地震情報を検出:', earthquakeInfo);
      await ChatworkBotUtils.notifyEarthquake(earthquakeInfo);
      memoryStorage.lastEarthquakeId = earthquakeInfo.id;
    }
  } catch (error) {
    console.error('地震情報チェックエラー:', error.message);
  }
}

// cron: 毎日0時0分に実行
cron.schedule('0 0 0 * * *', async () => {
  await sendDailyGreetingMessages();
}, {
  timezone: "Asia/Tokyo"
});

// cron: 毎日23時0分に実行
cron.schedule('0 0 23 * * *', async () => {
  await sendNightMessage();
}, {
  timezone: "Asia/Tokyo"
});

// cron: 毎日23時55分に実行
cron.schedule('0 55 23 * * *', async () => {
  await sendPreMidnightRanking();
}, {
  timezone: "Asia/Tokyo"
});

// cron: 毎日23時59分に実行
cron.schedule('0 59 23 * * *', async () => {
  await sendDailyRanking();
}, {
  timezone: "Asia/Tokyo"
});

// cron: 毎日6時0分に実行（朝のメッセージ + 今日の天気）
cron.schedule('0 0 6 * * *', async () => {
  await sendMorningMessage();
  // 今日の天気を送る
  await sendWeather(false);
}, {
  timezone: "Asia/Tokyo"
});

// cron: 毎日18時0分に実行（明日の天気）
cron.schedule('0 0 18 * * *', async () => {
  await sendWeather(true);
}, {
  timezone: "Asia/Tokyo"
});

// cron: 1分ごとに地震情報をチェック
cron.schedule('*/1 * * * *', async () => {
  await checkEarthquakeInfo();
}, {
  timezone: "Asia/Tokyo"
});

// サーバー起動
app.listen(port, async () => {
  console.log(`Chatwork Bot WebHook版 (全ルーム対応) がポート${port}で起動しました`);
  console.log('WebHook URL: https://your-app-name.onrender.com/webhook');
  console.log('環境変数:');
  console.log('- CHATWORK_API_TOKEN:', CHATWORK_API_TOKEN ? '設定済み' : '未設定');
  console.log('- INFO_API_TOKEN:', INFO_API_TOKEN ? '設定済み' : '未設定');
  console.log('- DATABASE_URL:', process.env.DATABASE_URL ? '設定済み' : '未設定');
  console.log('- DIRECT_CHAT_WITH_DATE_CHANGE:', DIRECT_CHAT_WITH_DATE_CHANGE);
  console.log('- LOG_ROOM_ID:', LOG_ROOM_ID, '(固定)');
  console.log('- DAY_JSON_URL:', DAY_JSON_URL);
  console.log('動作モード: すべてのルームで反応、ログは', LOG_ROOM_ID, 'のみ');

  console.log('\nデータベースを初期化します...');
  await initializeDatabase();

  console.log('\n起動時初期化: メッセージカウントを初期化します...');
  for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
    await ChatworkBotUtils.initializeMessageCount(roomId);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  console.log('初期化完了\n');
});
