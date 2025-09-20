// Chatwork Bot for Render (Node.js with PostgreSQL)

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// 環境変数から設定を読み込み
const CHATWORK_API_TOKEN = process.env.CHATWORK_API_TOKEN || '';
const DIRECT_CHAT_WITH_DATE_CHANGE = (process.env.DIRECT_CHAT_WITH_DATE_CHANGE || '405497983').split(',');

// Chatwork APIレートリミット制御追加
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

// PostgreSQL接続設定
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ルーム設定（環境変数から読み込み可能）
const ROOM_CONFIG = {
  '404646956': { memberSheetName: 'シート1', logSheetName: 'ログ' },
  '406897783': { memberSheetName: 'サブリスト', logSheetName: 'サブログ' },
  '391699365': { memberSheetName: '予備リスト', logSheetName: '予備ログ' },
  '397972033': { memberSheetName: '反省リスト', logSheetName: '反省ログ' },
  '407676893': { memberSheetName: 'らいとリスト', logSheetName: 'らいとログ'}
};

// テーブル作成
async function initializeDatabase() {
  try {
    const client = await pool.connect();

    // プロパティテーブル
    await client.query(`
      CREATE TABLE IF NOT EXISTS properties (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT
      )
    `);

    // メンバーテーブル
    await client.query(`
      CREATE TABLE IF NOT EXISTS members (
        room_id VARCHAR(50),
        account_id VARCHAR(50),
        name VARCHAR(255),
        role VARCHAR(50),
        join_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (room_id, account_id)
      )
    `);

    // ログテーブル
    await client.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id SERIAL PRIMARY KEY,
        room_id VARCHAR(50),
        user_name VARCHAR(255),
        user_id VARCHAR(50),
        message_body TEXT,
        message_id VARCHAR(50),
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 日付イベントテーブル
    await client.query(`
      CREATE TABLE IF NOT EXISTS date_events (
        id SERIAL PRIMARY KEY,
        date VARCHAR(50),
        event TEXT
      )
    `);

    client.release();
    console.log('データベース初期化完了');
  } catch (error) {
    console.error('データベース初期化エラー:', error.message);
  }
}
initializeDatabase();

// Chatwork絵文字のリスト
const CHATWORK_EMOJI_CODES = [
  "roger", "bow", "cracker", "dance", "clap", "y", "sweat", "blush", "inlove",
  "talk", "yawn", "puke", "emo", "nod", "shake", "^^;", ":/", "whew", "flex",
  "gogo", "think", "please", "quick", "anger", "devil", "lightbulb", "h", "F",
  "eat", "^", "coffee", "beer", "handshake"
].map(code => code.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'));

const CHATWORK_EMOJI_REGEX = new RegExp(`\\((${CHATWORK_EMOJI_CODES.join('|')})\\)`, 'g');

// API呼び出し制限対策
const API_CACHE = new Map();
const API_CALL_LIMITS = {
  rooms: { lastCall: 0, interval: 300000 }, // 5分間隔
  wikipedia: { lastCall: 0, interval: 60000 }, // 1分間隔
  scratch: { lastCall: 0, interval: 30000 }, // 30秒間隔
  yesorno: { lastCall: 0, interval: 10000 } // 10秒間隔
};

// --- ルーム分割管理 ---
let roomStartIndex = 0;
const MAX_ROOMS_PER_CYCLE = 2;

// ユーティリティ関数（apiCallLimiter追加済み）
class ChatworkBotUtils {

  static async getProperty(key) {
    try {
      const client = await pool.connect();
      const result = await client.query('SELECT value FROM properties WHERE key = $1', [key]);
      client.release();
      return result.rows[0] ? result.rows[0].value : null;
    } catch (error) {
      console.error('プロパティ取得エラー:', error.message);
      return null;
    }
  }

  static async setProperty(key, value) {
    try {
      const client = await pool.connect();
      await client.query(
        'INSERT INTO properties (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
        [key, value]
      );
      client.release();
    } catch (error) {
      console.error('プロパティ設定エラー:', error.message);
    }
  }

  static async getAllParticipatingRooms() {
    await apiCallLimiter();
    const cacheKey = 'allRooms';
    const now = Date.now();

    if (API_CACHE.has(cacheKey)) {
      const cachedData = API_CACHE.get(cacheKey);
      if (now - cachedData.timestamp < API_CALL_LIMITS.rooms.interval) {
        console.log(`キャッシュからルーム一覧を取得: ${cachedData.data.length}個`);
        return cachedData.data;
      }
    }
    if (now - API_CALL_LIMITS.rooms.lastCall < API_CALL_LIMITS.rooms.interval) {
      console.log('ルーム一覧取得のレート制限により、前回の結果を使用します');
      const cachedData = API_CACHE.get(cacheKey);
      return cachedData ? cachedData.data : [];
    }
    try {
      const response = await axios.get('https://api.chatwork.com/v2/rooms', {
        headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
      });
      const rooms = response.data;
      console.log(`取得したルーム数: ${rooms.length}`);
      API_CACHE.set(cacheKey, { data: rooms, timestamp: now });
      API_CALL_LIMITS.rooms.lastCall = now;
      return rooms;
    } catch (error) {
      console.error('ルーム一覧の取得中にエラーが発生しました:', error.message);
      return [];
    }
  }

  static isDirectChat(room) {
    return room.type === 'direct';
  }

  static async getChatworkMessages(roomId, lastMessageId = null) {
    await apiCallLimiter();
    try {
      let url = `https://api.chatwork.com/v2/rooms/${roomId}/messages?limit=100`;
      if (lastMessageId) {
        url += `&since_id=${lastMessageId}`;
      }
      const response = await axios.get(url, {
        headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
      });
      console.log(`ルーム ${roomId} - 取得したメッセージ数: ${response.data.length}`);
      return response.data;
    } catch (error) {
      console.error(`ルーム ${roomId} - メッセージ取得エラー:`, error.message);
      return [];
    }
  }

  static async getChatworkMembers(roomId) {
    await apiCallLimiter();
    try {
      const response = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}/members`, {
        headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
      });
      return response.data.map(member => ({
        account_id: member.account_id,
        name: member.name,
        role: member.role,
        icon: member.avatar_image_url || ''
      }));
    } catch (error) {
      console.error(`ルーム ${roomId} のメンバー取得エラー:`, error.message);
      return [];
    }
  }

  static async sendChatworkMessage(roomId, message) {
    await apiCallLimiter();
    try {
      await axios.post(`https://api.chatwork.com/v2/rooms/${roomId}/messages`,
        new URLSearchParams({ body: message }),
        { headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN } }
      );
      console.log(`ルーム ${roomId} にメッセージを送信しました`);
      return true;
    } catch (error) {
      console.error(`ルーム ${roomId} へのメッセージ送信エラー:`, error.message);
      return false;
    }
  }

  static countChatworkEmojis(text) {
    const matches = text.match(CHATWORK_EMOJI_REGEX);
    return matches ? matches.length : 0;
  }

  static drawOmikuji(isAdmin) {
    const fortunes = ['大吉', '中吉', '吉', '小吉', 'null', 'undefined'];
    const specialFortune = '超町長調帳朝腸蝶大吉';
    let specialChance = 0.002;
    if (isAdmin) {
      specialChance = 0.25;
    }
    const rand = Math.random();
    if (rand < specialChance) {
      return specialFortune;
    } else {
      const index = Math.floor(Math.random() * fortunes.length);
      return fortunes[index];
    }
  }

  static async getYesOrNoAnswer() {
    const now = Date.now();
    if (now - API_CALL_LIMITS.yesorno.lastCall < API_CALL_LIMITS.yesorno.interval) {
      console.log('Yes/No APIのレート制限により、ランダム回答を返します');
      const answers = ['yes', 'no'];
      return answers[Math.floor(Math.random() * answers.length)];
    }
    try {
      const response = await axios.get('https://yesno.wtf/api');
      API_CALL_LIMITS.yesorno.lastCall = now;
      return response.data.answer || '不明';
    } catch (error) {
      console.error('yesno.wtf APIの呼び出し中にエラー:', error.message);
      return 'APIエラーにより取得できませんでした。';
    }
  }

  static async getWikipediaSummary(searchTerm) {
    const now = Date.now();
    const cacheKey = `wiki_${searchTerm}`;
    if (API_CACHE.has(cacheKey)) {
      const cachedData = API_CACHE.get(cacheKey);
      if (now - cachedData.timestamp < 300000) {
        console.log(`Wikipediaキャッシュから取得: ${searchTerm}`);
        return cachedData.data;
      }
    }
    if (now - API_CALL_LIMITS.wikipedia.lastCall < API_CALL_LIMITS.wikipedia.interval) {
      console.log('Wikipedia APIのレート制限により、処理をスキップします');
      return `「${searchTerm}」の検索は一時的に制限されています。しばらく後に再試行してください。`;
    }
    try {
      const params = new URLSearchParams({
        action: 'query',
        format: 'json',
        prop: 'extracts',
        exintro: true,
        explaintext: true,
        redirects: 1,
        titles: searchTerm
      });
      const response = await axios.get(`https://ja.wikipedia.org/w/api.php?${params}`);
      API_CALL_LIMITS.wikipedia.lastCall = now;
      const data = response.data;
      let result;
      if (data.query && data.query.pages) {
        const pages = data.query.pages;
        const pageId = Object.keys(pages)[0];
        if (pageId && pages[pageId] && pages[pageId].extract) {
          let summary = pages[pageId].extract;
          if (summary.length > 500) {
            summary = summary.substring(0, 500) + '...';
          }
          const pageTitle = pages[pageId].title;
          const pageUrl = `https://ja.wikipedia.org/wiki/${encodeURIComponent(pageTitle)}`;
          result = `${summary}\n\n元記事: ${pageUrl}`;
        } else if (pageId && pages[pageId].missing !== undefined) {
          result = `「${searchTerm}」に関する記事は見つかりませんでした。`;
        } else {
          result = `「${searchTerm}」の検索結果を処理できませんでした。`;
        }
      } else {
        result = `「${searchTerm}」の検索結果を処理できませんでした。`;
      }
      API_CACHE.set(cacheKey, { data: result, timestamp: now });
      return result;
    } catch (error) {
      console.error('Wikipedia APIの呼び出し中にエラー:', error.message);
      return `Wikipedia検索中にエラーが発生しました。「${searchTerm}」`;
    }
  }

  static async getScratchUserStats(username) {
    const now = Date.now();
    if (now - API_CALL_LIMITS.scratch.lastCall < API_CALL_LIMITS.scratch.interval) {
      console.log('Scratch APIのレート制限により、処理をスキップします');
      return `「${username}」の情報取得は一時的に制限されています。しばらく後に再試行してください。`;
    }
    try {
      const response = await axios.get(`https://api.scratch.mit.edu/users/${encodeURIComponent(username)}`);
      API_CALL_LIMITS.scratch.lastCall = now;
      const data = response.data;
      const status = data.profile?.status ?? '情報なし';
      const userLink = `https://scratch.mit.edu/users/${encodeURIComponent(username)}/`;
      return `[info][title]Scratchユーザー情報[/title]ユーザー名: ${username}\nステータス: ${status}\nユーザーページ: ${userLink}[/info]`;
    } catch (error) {
      if (error.response?.status === 404) {
        return `「${username}」というScratchユーザーは見つかりませんでした。`;
      }
      console.error('ScratchユーザーAPIの呼び出し中にエラー:', error.message);
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
      return `[info][title]Scratchプロジェクト情報[/title]タイトル: ${data.title}\n作者: ${data.author.username}\n説明: ${data.description}\nURL: ${url}[/info]`;
    } catch (error) {
      return 'Scratchプロジェクト情報の取得中にエラーが発生しました。';
    }
  }

  static async getTodaysEvents() {
    try {
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth() + 1;
      const currentDay = now.getDate();
      const todayFormats = [
        `${currentYear}/${String(currentMonth).padStart(2, '0')}/${String(currentDay).padStart(2, '0')}`,
        `${String(currentMonth).padStart(2, '0')}/${String(currentDay).padStart(2, '0')}`,
        `${String(currentDay).padStart(2, '0')}`,
        `${currentYear}/${currentMonth}/${currentDay}`,
        `${currentMonth}/${currentDay}`,
        `${currentDay}`
      ];
      const client = await pool.connect();
      const placeholders = todayFormats.map((_, i) => `$${i+1}`).join(',');
      const result = await client.query(
        `SELECT event FROM date_events WHERE date IN (${placeholders})`,
        todayFormats
      );
      client.release();
      return result.rows.map(row => row.event);
    } catch (error) {
      console.error('今日のイベント取得エラー:', error.message);
      return [];
    }
  }

  static async addDateToList(date, event) {
    try {
      const client = await pool.connect();
      await client.query('INSERT INTO date_events (date, event) VALUES ($1, $2)', [date, event]);
      client.release();
    } catch (error) {
      console.error('日付イベント追加エラー:', error.message);
    }
  }
}

// メッセージ処理クラス（省略、元のまま）

// メイン処理クラス
class ChatworkBotMain {

  static async executeSingleCheck() {
    try {
      console.log('=== Chatworkボット処理開始 ===');

      // 全ルーム取得
      const allRooms = await ChatworkBotUtils.getAllParticipatingRooms();
      if (allRooms.length === 0) {
        console.log('参加しているルームが取得できませんでした。');
        return;
      }

      // --- ここから分割処理 ---
      // 2ルームずつ処理
      let roomsToProcess = [];
      if (roomStartIndex >= allRooms.length) roomStartIndex = 0;
      roomsToProcess = allRooms.slice(roomStartIndex, roomStartIndex + MAX_ROOMS_PER_CYCLE);
      roomStartIndex += MAX_ROOMS_PER_CYCLE;

      for (const room of roomsToProcess) {
        const roomId = room.room_id.toString();
        const roomName = room.name;
        const isDirectChatRoom = ChatworkBotUtils.isDirectChat(room);

        try {
          console.log(`ルーム処理開始: ${roomName} (ID: ${roomId}, タイプ: ${isDirectChatRoom ? 'ダイレクト' : 'グループ'})`);

          // メンバーリストの取得（グループチャットのみ）
          let currentMembers = [];
          if (!isDirectChatRoom) {
            currentMembers = await ChatworkBotUtils.getChatworkMembers(roomId);
          }

          // 1. 日付変更時のメッセージ送信
          const shouldSendDateChange = !isDirectChatRoom || DIRECT_CHAT_WITH_DATE_CHANGE.includes(roomId);
          if (shouldSendDateChange) {
            await this.sendDailyGreetingMessage(roomId, roomName);
          }

          // 2. メッセージ内容に応じたアクション
          await MessageProcessor.processMessagesForActions(roomId, currentMembers, isDirectChatRoom, roomName);

          console.log(`ルーム処理完了: ${roomName} (ID: ${roomId})`);

          // ルーム間で少し待機（API制限対策）
          await new Promise(resolve => setTimeout(resolve, 2000)); // 2秒待機

        } catch (error) {
          console.error(`ルーム ${roomId} (${roomName}) の処理中にエラー:`, error.message);
        }
      }

      console.log('=== Chatworkボット処理完了 ===');

    } catch (error) {
      console.error('Chatworkボット処理中にエラー:', error.message);
    }
  }

  // 日付変更メッセージ送信（省略、元のまま）
}

// Express.jsのルート設定（省略、元のまま）

// cron設定（15秒間隔でボット実行）
cron.schedule('*/15 * * * * *', async () => {
  console.log('定期実行開始:', new Date().toISOString());
  try {
    await ChatworkBotMain.executeSingleCheck();
  } catch (error) {
    console.error('定期実行エラー:', error.message);
  }
});

// サーバー起動（省略、元のまま）

module.exports = app;
