// ルームの今日のメッセージを全て取得（複数回リクエスト）
  static async getAllTodayMessages(roomId) {
    try {
      // 今日の0時0分0秒のタイムスタンプを取得（日本時間）
      const jstNow = new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" });
      const now = new Date(jstNow);
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      const todayStartTimestamp = Math.floor(todayStart.getTime() / 1000) + 32400; // +9時間

      let allMessages = [];
      let force = 0;
      let hasMore = true;
      let totalFetched = 0;

      // 日付変更までのメッセージを全て取得（100件ずつ）
      while (hasMore) {
        await apiCallLimiter();
        const response = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}/messages`, {
          headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN },
          params: { force: force }
        });

        const messages = response.data || [];
        totalFetched += messages.length;
        
        if (messages.length === 0) {
          console.log(`ルーム ${roomId}: これ以上メッセージがありません（合計${totalFetched}件取得）`);
          hasMore = false;
          break;
        }

        // 今日のメッセージと今日より前のメッセージを分離
        const todayMessages = [];
        let foundYesterday = false;

        for (const msg of messages) {
          if (msg.send_time >= todayStartTimestamp) {
            todayMessages.push(msg);
          } else {
            foundYesterday = true;
            break;
          }
        }

        allMessages = allMessages.concat(todayMessages);

        // 今日より前のメッセージが見つかったら終了
        if (foundYesterday) {
          console.log(`ルーム ${roomId}: 日付変更を検出。今日のメッセージ ${all// Chatwork Bot for Render (WebHook版 - 全ルーム対応)

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { Pool } = require('pg');

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
    
    // インデックス作成
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
const AI_API_TOKEN = process.env.AI_API_TOKEN || '';
const DIRECT_CHAT_WITH_DATE_CHANGE = (process.env.DIRECT_CHAT_WITH_DATE_CHANGE || '405497983,407676893,415060980').split(',');
const LOG_ROOM_ID = '404646956'; // ログ送信先のルームIDを固定
const DAY_JSON_URL = process.env.DAY_JSON_URL || 'https://raw.githubusercontent.com/shiratama-kotone/cw-bot/main/day.json';
const YUYUYU_ACCOUNT_ID = '10544705'; // ゆゆゆの本垢のアカウントID

// メモリ内データストレージ
const memoryStorage = {
  properties: new Map(),
  lastSentDates: new Map(), // 日付変更通知の最終送信日
  messageCounts: new Map(), // ルームIDごとのユーザー別メッセージ数 { roomId: { accountId: count } }
  roomResetDates: new Map(), // ルームIDごとの最終リセット日 { roomId: 'YYYY-MM-DD' }
  lastEarthquakeId: null, // 最後に通知した地震のID
};

// Chatwork APIレートリミット制御
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

// APIキャッシュ（サイズ制限付き）
const API_CACHE = new Map();
const MAX_CACHE_SIZE = 50; // キャッシュの最大サイズを制限

// キャッシュに追加する関数
function addToCache(key, value) {
  if (API_CACHE.size >= MAX_CACHE_SIZE) {
    // 最も古いエントリを削除
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

// 今日のイベント取得（day.json版）
async function getTodaysEventsFromJson() {
  try {
    const dayEvents = await loadDayEvents();
    const now = new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" });
    const jstDate = new Date(now);
    const monthDay = `${String(jstDate.getMonth() + 1).padStart(2, '0')}-${String(jstDate.getDate()).padStart(2, '0')}`;
    const day = String(jstDate.getDate()).padStart(2, '0');

    const events = [];

    // MM-DD形式のイベントをチェック
    if (dayEvents[monthDay]) {
      if (Array.isArray(dayEvents[monthDay])) {
        events.push(...dayEvents[monthDay]);
      } else {
        events.push(dayEvents[monthDay]);
      }
    }

    // DD形式のイベントをチェック
    if (dayEvents[day]) {
      if (Array.isArray(dayEvents[day])) {
        events.push(...dayEvents[day]);
      } else {
        events.push(dayEvents[day]);
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

  // ルーム情報を取得
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
        { headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
        }
      );
      return response.data.message_id;
    } catch (error) {
      console.error(`メッセージ送信エラー (${roomId}):`, error.message);
      return null;
    }
  }

  // ログをChatworkルームに送信する関数（指定ルームのみ）
  static async sendLogToChatwork(userName, messageBody, sourceRoomId) {
    try {
      // 指定されたルーム(404646956)からのメッセージのみログ送信
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
    const fortunes = ['大吉', '中吉', '吉', '小吉', 'null', 'undefined'];
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

  static async getWikipediaSummary(searchTerm) {
    const now = Date.now();
    const cacheKey = `wiki_${searchTerm}`;

    // キャッシュチェック
    if (API_CACHE.has(cacheKey)) {
      const cachedData = API_CACHE.get(cacheKey);
      if (now - cachedData.timestamp < 300000) { // 5分間キャッシュ
        return cachedData.data;
      }
    }

    try {
      const params = new URLSearchParams({
        action: 'query',
        format: 'json',
        prop: 'extracts',
        exintro: true,
        explaintext: true,
        redirects: 1,
        titles: searchTerm,
        origin: '*'
      });
      const response = await axios.get(`https://ja.wikipedia.org/w/api.php?${params}`, {
        timeout: 10000
      });
      const data = response.data;
      let result;
      if (data.query && data.query.pages) {
        const pages = data.query.pages;
        const pageId = Object.keys(pages)[0];
        if (pageId && pageId !== '-1' && pages[pageId] && pages[pageId].extract) {
          let summary = pages[pageId].extract;
          if (summary.length > 500) summary = summary.substring(0, 500) + '...';
          const pageTitle = pages[pageId].title;
          const pageUrl = `https://ja.wikipedia.org/wiki/${encodeURIComponent(pageTitle)}`;
          result = `${summary}\n\n元記事: ${pageUrl}`;
        } else if (pageId && (pageId === '-1' || pages[pageId].missing !== undefined)) {
          result = `「${searchTerm}」に関する記事は見つかりませんでした。`;
        } else {
          result = `「${searchTerm}」の検索結果を処理できませんでした。`;
        }
      } else {
        result = `「${searchTerm}」の検索結果を処理できませんでした。`;
      }
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

      // bioがある場合は「私について」として表示
      if (bio) {
        result += `[info][title]私について[/title]${bio}[/info]\n\n`;
      }

      // statusがある場合は「私が取り組んでいること」として表示
      if (status) {
        result += `[info][title]私が取り組んでいること[/title]${status}[/info]\n\n`;
      }

      // どちらもない場合
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

  // ルームのメッセージカウントを初期化（起動時・日付変更時用）
  static async initializeMessageCount(roomId) {
    try {
      console.log(`ルーム ${roomId} のメッセージカウントを初期化中...`);
      const messages = await this.getRoomMessages(roomId);

      // 今日の0時0分0秒のタイムスタンプを取得（日本時間）
      const jstNow = new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" });
      const now = new Date(jstNow);
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      const todayStartTimestamp = Math.floor(todayStart.getTime() / 1000) + 32400; // +9時間

      const counts = {};
      messages.forEach(msg => {
        if (msg.send_time >= todayStartTimestamp) {
          const accId = msg.account.account_id;
          counts[accId] = (counts[accId] || 0) + 1;
        }
      });

      // メモリに保存
      memoryStorage.messageCounts.set(roomId, counts);
      memoryStorage.roomResetDates.set(roomId, now.toISOString().split('T')[0]);

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
      // force=1で最新100件を強制取得
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

  // 特定のメッセージを取得
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

  // 画像をChatworkにアップロード
  static async uploadImageToChatwork(roomId, imageBuffer, filename) {
    try {
      await apiCallLimiter();
      const FormData = require('form-data');
      const form = new FormData();
      
      console.log('アップロード準備:', {
        roomId,
        filename,
        bufferLength: imageBuffer.length
      });

      // Bufferから直接アップロード
      form.append('file', imageBuffer, {
        filename: filename,
        contentType: 'image/png',
        knownLength: imageBuffer.length
      });

      // form.getLengthで実際のコンテンツ長を取得
      const contentLength = await new Promise((resolve, reject) => {
        form.getLength((err, length) => {
          if (err) reject(err);
          else resolve(length);
        });
      });

      console.log('FormDataサイズ:', contentLength);

      const response = await axios.post(
        `https://api.chatwork.com/v2/rooms/${roomId}/files`,
        form,
        {
          headers: {
            'X-ChatWorkToken': CHATWORK_API_TOKEN,
            ...form.getHeaders(),
            'Content-Length': contentLength
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        }
      );
      
      console.log('アップロード応答:', response.data);
      return response.data;
    } catch (error) {
      console.error(`画像アップロードエラー (${roomId}):`, error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
      return null;
    }
  }

  // P2P地震情報APIから最新の地震情報を取得
  static async getLatestEarthquakeInfo() {
    try {
      const response = await axios.get('https://api.p2pquake.net/v2/history?codes=551&limit=1');
      const data = response.data;
      
      if (!data || data.length === 0) {
        return null;
      }

      const earthquake = data[0];
      
      // 震度3以上のみ
      if (!earthquake.earthquake || earthquake.earthquake.maxScale < 30) {
        return null;
      }

      return {
        id: earthquake.id,
        time: earthquake.earthquake.time,
        hypocenter: earthquake.earthquake.hypocenter.name,
        magnitude: earthquake.earthquake.hypocenter.magnitude,
        maxScale: earthquake.earthquake.maxScale
      };
    } catch (error) {
      console.error('地震情報取得エラー:', error.message);
      return null;
    }
  }

  // 地震情報を通知
  static async notifyEarthquake(earthquakeInfo, isTest = false) {
    try {
      // 震度を数字に変換（P2P地震情報は10倍の値）
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
      const scale = scaleMap[earthquakeInfo.maxScale] || earthquakeInfo.maxScale / 10;

      // 日時をフォーマット（時間・分まで表示）
      const date = new Date(earthquakeInfo.time);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');

      const title = isTest ? '地震情報-テスト' : '地震情報';
      // マグニチュードが-1の場合は調査中
      const magnitudeText = isTest ? '不明' : (earthquakeInfo.magnitude === -1 ? '調査中' : earthquakeInfo.magnitude);
      
      const message = `[info][title]${title}[/title]${year}年${month}月${day}日 ${hours}:${minutes}に${earthquakeInfo.hypocenter}を中心とする震度${scale}の地震が発生しました。\nマグニチュードは、${magnitudeText}です。[/info]`;

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

  // Make it a Quote画像生成（外部API直接使用）
  static async createQuoteImage(roomId, targetRoomId, targetMessageId) {
    try {
      // メッセージを取得
      const message = await this.getMessage(targetRoomId, targetMessageId);
      
      if (!message) {
        return { success: false, error: 'メッセージが見つかりませんでした' };
      }

      const username = message.account.name;
      const avatar = message.account.avatar_image_url || 'https://www.chatwork.com/assets/images/common/avatar-default.png';
      const text = message.body;

      console.log('Quote画像生成開始:', { username, avatar: avatar.substring(0, 50), text: text.substring(0, 50) });

      // 外部APIを直接使用（常にカラー）
      const imageBuffer = await this.generateQuoteImageFromAPI(username, username, text, avatar, true);
      
      console.log('画像生成完了。Bufferサイズ:', imageBuffer.length);

      // Chatworkにアップロード
      const uploadResult = await this.uploadImageToChatwork(roomId, imageBuffer, 'quote.png');
      
      if (uploadResult) {
        console.log('アップロード成功:', uploadResult);
        return { success: true };
      } else {
        return { success: false, error: 'アップロードに失敗しました' };
      }
    } catch (error) {
      console.error('Quote画像生成エラー:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response headers:', error.response.headers);
        console.error('Response data length:', error.response.data?.length || 0);
      }
      return { success: false, error: error.message };
    }
  }

  // 指定ルームの情報を取得（INFO_API_TOKENを使用）
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

  // 指定ルームのメンバーを取得（INFO_API_TOKENを使用）
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

  // Google AI Studioと会話
  static async talkWithAI(message) {
    try {
      if (!AI_API_TOKEN) {
        return 'AI APIキーが設定されていません。';
      }

      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${AI_API_TOKEN}`,
        {
          contents: [{
            parts: [{
              text: message
            }]
          }]
        },
        {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      if (response.data.candidates && response.data.candidates.length > 0) {
        const content = response.data.candidates[0].content;
        if (content.parts && content.parts.length > 0) {
          return content.parts[0].text;
        }
      }

      return 'AIからの応答を取得できませんでした。';
    } catch (error) {
      console.error('AI会話エラー:', error.message);
      if (error.response) {
        console.error('Response data:', error.response.data);
      }
      return `AIとの会話中にエラーが発生しました: ${error.message}`;
    }
  }
  static async generateQuoteImageFromAPI(username, displayName, text, avatar, color) {
    try {
      let avatarData = avatar;
      
      // ChatworkのアバターURLの場合、画像をダウンロードしてbase64に変換
      if (avatar && !avatar.startsWith('data:image')) {
        try {
          console.log('アバター画像をダウンロード中:', avatar);
          const avatarResponse = await axios.get(avatar, {
            responseType: 'arraybuffer',
            timeout: 5000
          });
          
          const base64Image = Buffer.from(avatarResponse.data).toString('base64');
          // 常にPNG形式として扱う
          avatarData = `data:image/png;base64,${base64Image}`;
          console.log('アバター画像をPNG base64に変換しました');
        } catch (avatarError) {
          console.error('アバター画像のダウンロードエラー:', avatarError.message);
          // デフォルトアバターを使用
          avatarData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        }
      }

      // 外部APIを使用（POSTリクエスト）
      const response = await axios.post(
        'https://api.voids.top/fakequote',
        {
          username: username,
          display_name: displayName,
          text: text,
          avatar: avatarData,
          color: color
        },
        { 
          responseType: 'arraybuffer',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'image/png,image/*'
          },
          timeout: 10000
        }
      );
      
      if (!response.data || response.data.byteLength === 0) {
        throw new Error('画像データが空です');
      }

      return Buffer.from(response.data);
    } catch (error) {
      console.error('外部API画像生成エラー:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data?.toString().substring(0, 200));
      }
      throw error;
    }
  }
}

// WebHookメッセージ処理クラス
class WebHookMessageProcessor {
  // WebHookをデータベースに保存
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
      // データベースに保存
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

      // メッセージカウントを更新
      this.updateMessageCount(roomId, accountId);

      // ログ送信（指定ルームのみ）
      console.log(`ログ送信チェック: sourceRoomId=${roomId}, LOG_ROOM_ID=${LOG_ROOM_ID}`);
      await ChatworkBotUtils.sendLogToChatwork(userName, messageBody, roomId);

      let currentMembers = [];
      let isSenderAdmin = true;
      const isDirectChat = webhookData.room_type === 'direct';

      if (!isDirectChat) {
        currentMembers = await ChatworkBotUtils.getChatworkMembers(roomId);
        isSenderAdmin = this.isUserAdmin(accountId, currentMembers);
      }

      // すべてのルームでコマンドを処理
      await this.handleCommands(
        roomId,
        messageId,
        accountId,
        messageBody.trim(),
        isSenderAdmin,
        isDirectChat,
        currentMembers
      );
    } catch (error) {
      console.error('WebHookメッセージ処理エラー:', error.message);
    }
  }

  // メッセージカウントを更新
  static updateMessageCount(roomId, accountId) {
    try {
      // 今日の日付を取得（日本時間）
      const jstNow = new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" });
      const now = new Date(jstNow);
      const todayDateOnly = now.toISOString().split('T')[0];

      // ルームの最終リセット日を確認
      const lastResetDate = memoryStorage.roomResetDates.get(roomId);

      // 日付が変わっていたらリセット
      if (lastResetDate !== todayDateOnly) {
        memoryStorage.messageCounts.set(roomId, {});
        memoryStorage.roomResetDates.set(roomId, todayDateOnly);
        console.log(`ルーム ${roomId} のメッセージカウントをリセットしました (${todayDateOnly})`);
      }

      // ルームのメッセージカウントを取得
      let roomCounts = memoryStorage.messageCounts.get(roomId) || {};

      // カウントを増やす
      roomCounts[accountId] = (roomCounts[accountId] || 0) + 1;

      // 保存
      memoryStorage.messageCounts.set(roomId, roomCounts);
    } catch (error) {
      console.error('メッセージカウント更新エラー:', error.message);
    }
  }

  static async handleCommands(roomId, messageId, accountId, messageBody, isSenderAdmin, isDirectChat, currentMembers) {
    if (!isDirectChat && messageBody.includes('[toall]') && !isSenderAdmin) {
      console.log(`[toall]を検出した非管理者: ${accountId} in room ${roomId}`);
    }

    // Make it a Quote
    if (messageBody.startsWith('/make-it-a-quote ')) {
      const params = messageBody.substring('/make-it-a-quote '.length).trim().split(' ');
      if (params.length === 2) {
        const [targetRoomId, targetMessageId] = params;
        const result = await ChatworkBotUtils.createQuoteImage(roomId, targetRoomId, targetMessageId);
        
        if (!result.success) {
          const errorMessage = `[rp aid=${accountId} to=${roomId}-${messageId}]エラー: ${result.error}`;
          await ChatworkBotUtils.sendChatworkMessage(roomId, errorMessage);
        }
      } else {
        const errorMessage = `[rp aid=${accountId} to=${roomId}-${messageId}]使用方法: /make-it-a-quote {ルームID} {メッセージID}`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, errorMessage);
      }
      return;
    }

    if (messageBody === 'おみくじ') {
      const omikujiResult = ChatworkBotUtils.drawOmikuji(isSenderAdmin);
      const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}][pname:${accountId}]さん、[info][title]おみくじ[/title]おみくじの結果は…\n\n${omikujiResult}\n\nです！[/info]`;
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

    // /info/{ルームID}コマンド: 指定ルームの情報表示
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

        // メンバーを取得してゆゆゆが参加しているか確認
        const members = await ChatworkBotUtils.getRoomMembersWithToken(targetRoomId, INFO_API_TOKEN);
        const isYuyuyuMember = members.some(m => m.account_id === parseInt(YUYUYU_ACCOUNT_ID));
        
        if (!isYuyuyuMember) {
          await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]ゆゆゆの本垢が参加していません。`);
          return;
        }

        // ルーム情報を整形
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

        const infoMessage = `[rp aid=${accountId} to=${roomId}-${messageId}][info][title]${roomName}の情報[/title]部屋名：${roomName}\nメンバー数：${memberCount}人\n管理者数：${adminCount}人\nルームID：${targetRoomId}\nファイル数：${fileCount}個\nメッセージ数：${messageCount}件\nアイコンリンク：${iconLink}\n[info][title]管理者[/title]${adminList}[/info][/info]`;

        await ChatworkBotUtils.sendChatworkMessage(roomId, infoMessage);
      } catch (error) {
        console.error('ルーム情報取得エラー:', error.message);
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]ルーム情報の取得中にエラーが発生しました。`);
      }
      return;
    }

    // /aiコマンド: Google AIと会話
    if (messageBody.startsWith('/ai/')) {
      const aiMessage = messageBody.substring('/ai/'.length).trim();
      if (aiMessage) {
        const aiResponse = await ChatworkBotUtils.talkWithAI(aiMessage);
        const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}][pname:${accountId}]さん、AIの応答です。\n\n${aiResponse}`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, replyMessage);
      } else {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]使用方法: /ai/{メッセージ}`);
      }
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
      const jstNow = new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" });
      const now = new Date(jstNow);
      const todayFormatted = now.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
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

    // /infoコマンド: ルーム情報表示
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
        
        // 最新メッセージを取得してメッセージIDを取得
        const messages = await ChatworkBotUtils.getRoomMessages(roomId);
        let messageLink = 'なし';
        if (messages && messages.length > 0) {
          const latestMessageId = messages[0].message_id;
          messageLink = `https://www.chatwork.com/#!rid${roomId}-${latestMessageId}`;
        }
        
        // アイコンリンク（icon_pathは相対パスまたは絶対URLの可能性がある）
        let iconLink = 'なし';
        if (iconPath) {
          if (iconPath.startsWith('http')) {
            iconLink = iconPath;
          } else {
            iconLink = `https://appdata.chatwork.com${iconPath}`;
          }
        }

        // 管理者のリスト
        const admins = currentMembers.filter(m => m.role === 'admin');
        let adminList = '';
        if (admins.length > 0) {
          adminList = admins.map(admin => `[picon:${admin.account_id}]`).join(' ');
        } else {
          adminList = 'なし';
        }

        const infoMessage = `[info][title]${roomName}の情報[/title]部屋名：${roomName}\nメンバー数：${memberCount}人\n管理者数：${adminCount}人\nルームID：${roomId}\nファイル数：${fileCount}個\nメッセージ数：${messageCount}件\nメッセージリンク：${messageLink}\nアイコンリンク：${iconLink}\n[info][title]管理者[/title]${adminList}[/info][/info]`;

        await ChatworkBotUtils.sendChatworkMessage(roomId, infoMessage);
      } catch (error) {
        console.error('ルーム情報取得エラー:', error.message);
        await ChatworkBotUtils.sendChatworkMessage(roomId, 'ルーム情報の取得中にエラーが発生しました。');
      }
    }

    // /romeraコマンド: メッセージ数ランキング
    if (messageBody === '/romera') {
      try {
        console.log(`ルーム ${roomId} のランキングを作成中...`);

        // メモリから今日のカウントを取得
        let roomCounts = memoryStorage.messageCounts.get(roomId) || {};

        // メモリにデータがない場合、APIから今日のメッセージを全て取得して初期化
        if (Object.keys(roomCounts).length === 0) {
          console.log(`メモリにデータがないため、今日のメッセージを全て取得します...`);
          roomCounts = await ChatworkBotUtils.initializeMessageCount(roomId);
        }

        // ランキング作成
        const ranking = Object.entries(roomCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([accountId, count], index) => ({
            rank: index + 1,
            accountId,
            count
          }));

        // 合計メッセージ数
        const totalCount = ranking.reduce((sum, item) => sum + item.count, 0);

        // メッセージ作成
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

    // /komekasegiコマンド: コメ稼ぎ
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

      // 10回送信
      for (let i = 0; i < 10; i++) {
        const randomMessage = messages[Math.floor(Math.random() * messages.length)];
        await ChatworkBotUtils.sendChatworkMessage(roomId, randomMessage);
        
        // 最後以外は1秒待つ
        if (i < 9) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    const responses = {
      'はんせい': `[To:9859068] なかよし\n[pname:${accountId}]に呼ばれてるよ！`,
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

    // テスト用の地震情報を作成
    const now = new Date();
    const testEarthquakeInfo = {
      id: `test_${Date.now()}`,
      time: now.toISOString(),
      hypocenter: 'テスト震源地',
      magnitude: null, // テストでは不明
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

// Make it a Quote画像生成エンドポイント
app.get('/miaq', async (req, res) => {
  try {
    const { 'u-name': username, 'd-name': displayName, text, avatar, color } = req.query;

    // 必須パラメータチェック
    if (!text || !avatar) {
      return res.status(400).json({
        status: 'error',
        message: '必須パラメータが不足しています: text, avatar'
      });
    }

    const finalUsername = username || 'Anonymous';
    const finalDisplayName = displayName || username || 'Anonymous';
    // 常にカラー
    const isColor = true;

    console.log('MIAQ画像生成リクエスト:', { 
      username: finalUsername, 
      displayName: finalDisplayName, 
      text: text.substring(0, 50), 
      avatar: avatar.substring(0, 50), 
      color: isColor 
    });

    // 外部APIから画像を生成
    const imageBuffer = await ChatworkBotUtils.generateQuoteImageFromAPI(
      finalUsername, 
      finalDisplayName, 
      text, 
      avatar, 
      isColor
    );

    // 画像をレスポンスとして返す
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

// 日付変更通知（cronで実行）
async function sendDailyGreetingMessages() {
  try {
    console.log('日付変更通知の送信を開始します');

    // ★修正箇所: JST時刻の取得を安定させる
    const now = new Date();
    const jstOffset = 9 * 60 * 60 * 1000;
    const jstTime = now.getTime() + jstOffset;
    const jstDate = new Date(jstTime);
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
            
            // 日付が変わったのでメッセージカウントをリセット
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

        // メモリから今日のカウントを取得
        let roomCounts = memoryStorage.messageCounts.get(roomId) || {};

        // メモリにデータがない場合、今日のメッセージを全て取得
        if (Object.keys(roomCounts).length === 0) {
          console.log(`メモリにデータがないため、今日のメッセージを全て取得します...`);
          roomCounts = await ChatworkBotUtils.initializeMessageCount(roomId);
        }

        // ランキング作成
        const ranking = Object.entries(roomCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([accountId, count], index) => ({
            rank: index + 1,
            accountId,
            count
          }));

        // 合計メッセージ数
        const totalCount = ranking.reduce((sum, item) => sum + item.count, 0);

        // メッセージ作成
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

// cron: 毎日0時0分に実行（日本時間で日付変更通知用）
cron.schedule('0 0 0 * * *', async () => {
  await sendDailyGreetingMessages();
}, {
  timezone: "Asia/Tokyo"
});

// cron: 毎日23時0分に実行（日本時間で夜の挨拶）
cron.schedule('0 0 23 * * *', async () => {
  await sendNightMessage();
}, {
  timezone: "Asia/Tokyo"
});

// cron: 毎日23時59分に実行（日本時間で今日のランキング）
cron.schedule('59 23 * * *', async () => {
  await sendDailyRanking();
}, {
  timezone: "Asia/Tokyo"
});

// cron: 毎日6時0分に実行（日本時間で朝の挨拶）
cron.schedule('0 0 6 * * *', async () => {
  await sendMorningMessage();
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
  console.log('- AI_API_TOKEN:', AI_API_TOKEN ? '設定済み' : '未設定');
  console.log('- DATABASE_URL:', process.env.DATABASE_URL ? '設定済み' : '未設定');
  console.log('- DIRECT_CHAT_WITH_DATE_CHANGE:', DIRECT_CHAT_WITH_DATE_CHANGE);
  console.log('- LOG_ROOM_ID:', LOG_ROOM_ID, '(固定)');
  console.log('- DAY_JSON_URL:', DAY_JSON_URL);
  console.log('動作モード: すべてのルームで反応、ログは', LOG_ROOM_ID, 'のみ');
  
  // データベース初期化
  console.log('\nデータベースを初期化します...');
  await initializeDatabase();
  
  // 起動時にメッセージカウントを初期化
  console.log('\n起動時初期化: メッセージカウントを初期化します...');
  for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
    await ChatworkBotUtils.initializeMessageCount(roomId);
    // API制限を避けるため少し待つ
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  console.log('初期化完了\n');
});