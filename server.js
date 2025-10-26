// Chatwork Bot for Render (WebHook版 - 全ルーム対応)

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const port = process.env.PORT || 3000;

// 環境変数から設定を読み込み
const CHATWORK_API_TOKEN = process.env.CHATWORK_API_TOKEN || '';
const DIRECT_CHAT_WITH_DATE_CHANGE = (process.env.DIRECT_CHAT_WITH_DATE_CHANGE || '405497983,404646956').split(',');
const LOG_ROOM_ID = '404646956'; // ログ送信先のルームIDを固定
const DAY_JSON_URL = process.env.DAY_JSON_URL || 'https://raw.githubusercontent.com/shiratama-kotone/cw-bot/main/day.json';

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
      addToCache(cacheKey, { data: result, timestamp: now });
      return result;
    } catch (error) {
      return `Wikipedia検索中にエラーが発生しました。「${searchTerm}」`;
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

  // ルームのメッセージを取得（最新100件のみ - Chatwork APIの制限）
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

      // 日時をフォーマット
      const date = new Date(earthquakeInfo.time);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');

      const title = isTest ? '地震情報-テスト' : '地震情報';
      const magnitudeText = isTest ? '不明' : earthquakeInfo.magnitude;
      
      const message = `[info][title]${title}[/title]${year}年${month}月${day}日に${earthquakeInfo.hypocenter}を中心とする震度${scale}の地震が発生しました。\nマグニチュードは、${magnitudeText}です。[/info]`;

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

  // Make it a Quote画像生成（独自API使用）
  static async createQuoteImage(roomId, targetRoomId, targetMessageId) {
    try {
      // メッセージを取得
      const message = await this.getMessage(targetRoomId, targetMessageId);
      
      if (!message) {
        return { success: false, error: 'メッセージが見つかりませんでした' };
      }

      const username = message.account.name;
      const displayName = message.account.name;
      const avatar = message.account.avatar_image_url || 'https://www.chatwork.com/assets/images/common/avatar-default.png';
      const text = message.body;

      console.log('Quote画像生成開始:', { username, displayName, avatar: avatar.substring(0, 50), text: text.substring(0, 50) });

      // 独自のMake it a Quote APIを使用
      const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
      const quoteUrl = `${baseUrl}/miaq?u-name=${encodeURIComponent(username)}&d-name=${encodeURIComponent(displayName)}&text=${encodeURIComponent(text)}&avatar=${encodeURIComponent(avatar)}&color=true`;
      
      console.log('画像取得URL:', quoteUrl);
      
      const response = await axios.get(quoteUrl, { 
        responseType: 'arraybuffer',
        headers: {
          'Accept': 'image/png,image/*'
        }
      });
      
      console.log('画像取得完了:', {
        status: response.status,
        contentType: response.headers['content-type'],
        dataLength: response.data.byteLength
      });

      if (!response.data || response.data.byteLength === 0) {
        return { success: false, error: '画像データが空です' };
      }

      const imageBuffer = Buffer.from(response.data);
      
      console.log('Bufferサイズ:', imageBuffer.length);

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

  // Make it a Quote画像を生成（外部API使用）
  static async generateQuoteImageFromAPI(username, displayName, text, avatar, color) {
    try {
      // 外部APIを使用
      const apiUrl = `https://api.voids.top/fakequote?username=${encodeURIComponent(displayName)}&avatar=${encodeURIComponent(avatar)}&message=${encodeURIComponent(text)}`;
      
      const response = await axios.get(apiUrl, { 
        responseType: 'arraybuffer',
        headers: {
          'Accept': 'image/png,image/*'
        },
        timeout: 10000
      });
      
      if (!response.data || response.data.byteLength === 0) {
        throw new Error('画像データが空です');
      }

      return Buffer.from(response.data);
    } catch (error) {
      console.error('外部API画像生成エラー:', error.message);
      throw error;
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

      // メッセージカウントを更新
      this.updateMessageCount(roomId, accountId);

      // ログ送信（指定ルームのみ）
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

    // /romeraコマンド: メッセージ数ランキング
    if (messageBody === '/romera') {
      try {
        console.log(`ルーム ${roomId} のランキングを作成中...`);

        // メモリから今日のカウントを取得
        let roomCounts = memoryStorage.messageCounts.get(roomId) || {};

        // メモリにデータがない場合、APIから最新100件を取得して初期化
        if (Object.keys(roomCounts).length === 0) {
          console.log(`メモリにデータがないため、APIから最新100件を取得します...`);
          const messages = await ChatworkBotUtils.getRoomMessages(roomId);

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
          roomCounts = counts;

          console.log(`APIから${messages.length}件取得し、今日のメッセージ${Object.values(counts).reduce((a, b) => a + b, 0)}件をカウントしました`);
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
    if (!username || !displayName || !text || !avatar) {
      return res.status(400).json({
        status: 'error',
        message: '必須パラメータが不足しています: u-name, d-name, text, avatar'
      });
    }

    console.log('MIAQ画像生成リクエスト:', { username, displayName, text: text.substring(0, 50), avatar: avatar.substring(0, 50), color });

    const isColor = color === 'true';

    // 外部APIから画像を生成
    const imageBuffer = await ChatworkBotUtils.generateQuoteImageFromAPI(username, displayName, text, avatar, isColor);

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
app.listen(port, () => {
  console.log(`Chatwork Bot WebHook版 (全ルーム対応) がポート${port}で起動しました`);
  console.log('WebHook URL: https://your-app-name.onrender.com/webhook');
  console.log('環境変数:');
  console.log('- CHATWORK_API_TOKEN:', CHATWORK_API_TOKEN ? '設定済み' : '未設定');
  console.log('- DIRECT_CHAT_WITH_DATE_CHANGE:', DIRECT_CHAT_WITH_DATE_CHANGE);
  console.log('- LOG_ROOM_ID:', LOG_ROOM_ID, '(固定)');
  console.log('- DAY_JSON_URL:', DAY_JSON_URL);
  console.log('動作モード: すべてのルームで反応、ログは', LOG_ROOM_ID, 'のみ');
});
