// Chatwork Bot for Render (WebHook版 - DB不使用) 修正版（API上限チェックなし） 

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const port = process.env.PORT || 3000;

// 環境変数から設定を読み込み
const CHATWORK_API_TOKEN = process.env.CHATWORK_API_TOKEN || '';
const DIRECT_CHAT_WITH_DATE_CHANGE = (process.env.DIRECT_CHAT_WITH_DATE_CHANGE || '405497983,404646956').split(',');
const LOG_ROOM_ID = process.env.LOG_ROOM_ID || '410459928'; // ログ送信先のルームID
const DAY_JSON_URL = process.env.DAY_JSON_URL || 'https://raw.githubusercontent.com/shiratama-kotone/cw-bot/main/day.json';

// メモリ内データストレージ
const memoryStorage = {
  properties: new Map(),
  lastSentDates: new Map(), // 日付変更通知の最終送信日
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

// APIキャッシュ
const API_CACHE = new Map();

// day.json読み込み関数
async function loadDayEvents() {
  try {
    const response = await axios.get(DAY_JSON_URL);
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
  
  static async sendChatworkMessage(roomId, message) {
    await apiCallLimiter();
    try {
      await axios.post(`https://api.chatwork.com/v2/rooms/${roomId}/messages`,
        new URLSearchParams({ body: message }),
        { headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
        }
      );
      return true;
    } catch (error) {
      console.error(`メッセージ送信エラー (${roomId}):`, error.message);
      return false;
    }
  }

  // ログをChatworkルームに送信する関数
  static async sendLogToChatwork(userName, messageBody, roomName = '') {
    try {
      const logMessage = `[info][title]${userName}[/title]${messageBody}[/info]`;
      await this.sendChatworkMessage(LOG_ROOM_ID, logMessage);
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

    // キャッシュチェック（任意）
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
        titles: searchTerm
      });
      const response = await axios.get(`https://ja.wikipedia.org/w/api.php?${params}`);
      const data = response.data;
      let result;
      if (data.query && data.query.pages) {
        const pages = data.query.pages;
        const pageId = Object.keys(pages)[0];
        if (pageId && pages[pageId] && pages[pageId].extract) {
          let summary = pages[pageId].extract;
          if (summary.length > 500) summary = summary.substring(0, 500) + '...';
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
      return `Wikipedia検索中にエラーが発生しました。「${searchTerm}」`;
    }
  }
  
  static async getScratchUserStats(username) {
    try {
      const response = await axios.get(`https://api.scratch.mit.edu/users/${encodeURIComponent(username)}`);
      const data = response.data;
      const status = data.profile?.status ?? '情報なし';
      const userLink = `https://scratch.mit.edu/users/${encodeURIComponent(username)}/`;
      return `[info][title]Scratchユーザー情報[/title]ユーザー名: ${username}\nステータス: ${status}\nユーザーページ: ${userLink}[/info]`;
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
}

// WebHookメッセージ処理クラス
class WebHookMessageProcessor {
  static async processWebHookMessage(webhookData) {
    try {
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

      await ChatworkBotUtils.sendLogToChatwork(userName, messageBody);

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
        messageBody.trim(),
        isSenderAdmin,
        isDirectChat,
        currentMembers
      );
    } catch (error) {
      console.error('WebHookメッセージ処理エラー:', error.message);
    }
  }

  static async handleCommands(roomId, messageId, accountId, messageBody, isSenderAdmin, isDirectChat, currentMembers) {
    if (!isDirectChat && messageBody.includes('[toall]') && !isSenderAdmin) {
      console.log(`[toall]を検出した非管理者: ${accountId} in room ${roomId}`);
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

    const responses = {
      'はんせい': `[To:9859068] なかよし\n[pname:${accountId}]に呼ばれてるよ！`,
      'ゆゆゆ': `[To:10544705] ゆゆゆ\n[pname:${accountId}]に呼ばれてるよ！`,
      'からめり': `[To:10337719] からめり\n[pname:${accountId}]に呼ばれてるよ！`,
      'いろいろあぷり': `https://shiratama-kotone.github.io/any-app/`,
      '喘げ': `...っ♡///`,
      'おやすみ': `おやすみなさい！[pname:${accountId}]！`,
      'おはよう': `[pname:${accountId}] おはよう！`,
      '/test': `アカウントID:${accountId}`
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
    message: 'Chatwork Bot WebHook版 (DB不使用 - day.json対応)',
    timestamp: new Date().toISOString(),
    mode: 'WebHook',
    storage: 'Memory'
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
      mode: 'WebHook',
      storage: 'Memory',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      logRoomId: LOG_ROOM_ID,
      dayJsonUrl: DAY_JSON_URL,
      directChatRooms: DIRECT_CHAT_WITH_DATE_CHANGE,
      memoryUsage: {
        apiCacheSize: API_CACHE.size,
        lastSentDatesSize: memoryStorage.lastSentDates.size
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

// 日付変更通知（cronで実行）
async function sendDailyGreetingMessages() {
  try {
    const jstNow = new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" });
    const now = new Date(jstNow);
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    if (currentHour === 0 && currentMinute === 0) {
      console.log('日付変更通知の送信を開始します');
      const todayFormatted = now.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
      const todayDateOnly = now.toISOString().split('T')[0];
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
            }
          }
        } catch (error) {
          console.error(`ルーム ${roomId} への日付変更通知送信エラー:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('日付変更通知処理エラー:', error.message);
  }
}

// cron: 毎分0秒に実行（日本時間で日付変更通知用）
cron.schedule('0 * * * * *', async () => {
  await sendDailyGreetingMessages();
}, {
  timezone: "Asia/Tokyo"
});

// サーバー起動
app.listen(port, () => {
  console.log(`Chatwork Bot WebHook版 (DB不使用) がポート${port}で起動しました`);
  console.log('WebHook URL: https://your-app-name.onrender.com/webhook');
  console.log('環境変数:');
  console.log('- CHATWORK_API_TOKEN:', CHATWORK_API_TOKEN ? '設定済み' : '未設定');
  console.log('- DIRECT_CHAT_WITH_DATE_CHANGE:', DIRECT_CHAT_WITH_DATE_CHANGE);
  console.log('- LOG_ROOM_ID:', LOG_ROOM_ID);
  console.log('- DAY_JSON_URL:', DAY_JSON_URL);
});

module.exports = app;
