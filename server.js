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

// ユーティリティ関数
class ChatworkBotUtils {

  // プロパティの取得・設定
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

  // 参加している全ルームを取得（キャッシュ付き）
  static async getAllParticipatingRooms() {
    const cacheKey = 'allRooms';
    const now = Date.now();

    // キャッシュから取得を試行
    if (API_CACHE.has(cacheKey)) {
      const cachedData = API_CACHE.get(cacheKey);
      if (now - cachedData.timestamp < API_CALL_LIMITS.rooms.interval) {
        console.log(`キャッシュからルーム一覧を取得: ${cachedData.data.length}個`);
        return cachedData.data;
      }
    }

    // レート制限チェック
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

      // キャッシュに保存
      API_CACHE.set(cacheKey, { data: rooms, timestamp: now });
      API_CALL_LIMITS.rooms.lastCall = now;

      return rooms;
    } catch (error) {
      console.error('ルーム一覧の取得中にエラーが発生しました:', error.message);
      return [];
    }
  }

  // ルームタイプを判定
  static isDirectChat(room) {
    return room.type === 'direct';
  }

  // メッセージ取得
  static async getChatworkMessages(roomId, lastMessageId = null) {
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

  // メンバー取得
  static async getChatworkMembers(roomId) {
    try {
      const response = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}/members`, {
        headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
      });

      return response.data.map(member => ({
        account_id: member.account_id,
        name: member.name,
        role: member.role,
        icon: member.avatar_image_url || '' // Chatwork API仕様により
      }));
    } catch (error) {
      console.error(`ルーム ${roomId} のメンバー取得エラー:`, error.message);
      return [];
    }
  }

  // メッセージ送信
  static async sendChatworkMessage(roomId, message) {
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

  // 絵文字カウント
  static countChatworkEmojis(text) {
    const matches = text.match(CHATWORK_EMOJI_REGEX);
    return matches ? matches.length : 0;
  }

  // おみくじ
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

  // Yes/No答え（レート制限付き）
  static async getYesOrNoAnswer() {
    const now = Date.now();

    // レート制限チェック
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

  // Wikipedia検索（キャッシュ・レート制限付き）
  static async getWikipediaSummary(searchTerm) {
    const now = Date.now();
    const cacheKey = `wiki_${searchTerm}`;

    // キャッシュから取得を試行
    if (API_CACHE.has(cacheKey)) {
      const cachedData = API_CACHE.get(cacheKey);
      if (now - cachedData.timestamp < 300000) { // 5分間キャッシュ
        console.log(`Wikipediaキャッシュから取得: ${searchTerm}`);
        return cachedData.data;
      }
    }

    // レート制限チェック
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

      // キャッシュに保存
      API_CACHE.set(cacheKey, { data: result, timestamp: now });
      return result;

    } catch (error) {
      console.error('Wikipedia APIの呼び出し中にエラー:', error.message);
      return `Wikipedia検索中にエラーが発生しました。「${searchTerm}」`;
    }
  }

  // Scratchユーザー情報取得
  static async getScratchUserStats(username) {
    const now = Date.now();

    // レート制限チェック
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

  // Scratchプロジェクト情報取得
  static async getScratchProjectInfo(projectId) {
    try {
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

  // 今日のイベントを取得
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
      // ?パラメータをちゃんと生成
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

  // 日付イベント追加
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

// メッセージ処理クラス
class MessageProcessor {

  static async processMessagesForActions(roomId, currentMembers, isDirectChat, roomName = '') {
    try {
      const lastMessageIdKey = `lastProcessedMessageId_${roomId}`;
      const lastMessageId = await ChatworkBotUtils.getProperty(lastMessageIdKey);
      const messages = await ChatworkBotUtils.getChatworkMessages(roomId, lastMessageId);

      if (messages.length === 0) {
        console.log(`ルーム ${roomName} (${roomId}) に新しいメッセージはありません。`);
        return;
      }

      for (const message of messages) {
        if (!message.message_id || !message.account || !message.account.account_id || !message.account.name) {
          console.log(`ルーム ${roomId} の不完全なメッセージをスキップ:`, message);
          continue;
        }

        // ログ記録（設定があるルームのみ）
        if (!isDirectChat && ROOM_CONFIG[roomId]) {
          await this.writeToLog(roomId, message.account.name, message.account.account_id, message.body, message.message_id);
        }

        const isSenderAdmin = isDirectChat ? true : this.isUserAdmin(message.account.account_id, currentMembers);
        const messageBody = message.body.trim();

        // 各種コマンド処理
        await this.handleCommands(roomId, message, messageBody, isSenderAdmin, isDirectChat, currentMembers);

        // 最後に処理したメッセージIDを更新
        await ChatworkBotUtils.setProperty(lastMessageIdKey, message.message_id);
      }
    } catch (error) {
      console.error(`ルーム ${roomId} のメッセージ処理中にエラー:`, error.message);
    }
  }

  static async handleCommands(roomId, message, messageBody, isSenderAdmin, isDirectChat, currentMembers) {
    const accountId = message.account.account_id;
    const messageId = message.message_id;

    // 1. [toall] 検知と権限変更（グループチャットのみ）
    if (!isDirectChat && messageBody.includes('[toall]') && !isSenderAdmin) {
      console.log(`ルーム ${roomId} で [toall] を検出した非管理者: ${message.account.name}`);
      // 権限変更機能は実装省略（複雑なため）
    }

    // 2. おみくじ機能
    if (messageBody === 'おみくじ') {
      const omikujiResult = ChatworkBotUtils.drawOmikuji(isSenderAdmin);
      const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}][pname:${accountId}]さん、[info][title]おみくじ[/title]おみくじの結果は…\n\n${omikujiResult}\n\nです！[/info]`;
      await ChatworkBotUtils.sendChatworkMessage(roomId, replyMessage);
    }

    // 3. Chatwork絵文字50個以上で警告（グループチャットのみ）
    if (!isDirectChat && !isSenderAdmin) {
      const emojiCount = ChatworkBotUtils.countChatworkEmojis(messageBody);
      if (emojiCount >= 50) {
        console.log(`ルーム ${roomId} で Chatwork絵文字50個以上を検出: ${message.account.name}, 絵文字数: ${emojiCount}`);
        const warningMessage = `[To:${accountId}][pname:${accountId}]さん、Chatwork絵文字を${emojiCount}個送信されました。適度な使用をお願いします。`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, warningMessage);
      }
    }

    // 4. /day-write コマンド
    if (messageBody.startsWith('/day-write ')) {
      await this.handleDayWriteCommand(roomId, message, messageBody);
    }

    // 5. /yes-or-no コマンド
    if (messageBody === '/yes-or-no') {
      const answer = await ChatworkBotUtils.getYesOrNoAnswer();
      const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}][pname:${accountId}]さん、答えは「${answer}」です！`;
      await ChatworkBotUtils.sendChatworkMessage(roomId, replyMessage);
    }

    // 6. /wiki コマンド
    if (messageBody.startsWith('/wiki/')) {
      const searchTerm = messageBody.substring('/wiki/'.length).trim();
      if (searchTerm) {
        const wikipediaSummary = await ChatworkBotUtils.getWikipediaSummary(searchTerm);
        const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}][pname:${accountId}]さん、Wikipediaの検索結果です。\n\n${wikipediaSummary}`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, replyMessage);
      }
    }

    // 7. /scratch-user コマンド
    if (messageBody.startsWith('/scratch-user/')) {
      const username = messageBody.substring('/scratch-user/'.length).trim();
      if (username) {
        const userStats = await ChatworkBotUtils.getScratchUserStats(username);
        const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}][pname:${accountId}]さん、Scratchユーザー「${username}」の情報です。\n\n${userStats}`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, replyMessage);
      }
    }

    // 8. /scratch-project コマンド
    if (messageBody.startsWith('/scratch-project/')) {
      const projectId = messageBody.substring('/scratch-project/'.length).trim();
      if (projectId) {
        const projectInfo = await ChatworkBotUtils.getScratchProjectInfo(projectId);
        const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}][pname:${accountId}]さん、Scratchプロジェクト「${projectId}」の情報です。\n\n${projectInfo}`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, replyMessage);
      }
    }

    // 9. /today コマンド
    if (messageBody === '/today') {
      const now = new Date();
      const todayFormatted = now.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
      let messageContent = `[info][title]今日の情報[/title]今日は${todayFormatted}だよ！`;

      const events = await ChatworkBotUtils.getTodaysEvents();
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

    // 10. /member コマンド（グループチャットのみ）
    if (!isDirectChat && messageBody === '/member') {
      const members = currentMembers;
      if (members.length > 0) {
        let reply = '[info][title]メンバー一覧[/title]\n';
        members.forEach(member => {
          reply += `・${member.name} (${member.role})\n`;
        });
        reply += '[/info]';
        await ChatworkBotUtils.sendChatworkMessage(roomId, reply);
      }
    }

    // 11. /member-name コマンド（グループチャットのみ）
    if (!isDirectChat && messageBody === '/member-name') {
      const members = currentMembers;
      if (members.length > 0) {
        const names = members.map(m => m.name).join(', ');
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[info][title]メンバー名一覧[/title]\n${names}[/info]`);
      }
    }

    // 12. 固定応答コマンド
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

  static async handleDayWriteCommand(roomId, message, messageBody) {
    const dateAndEvent = messageBody.substring('/day-write '.length).trim();
    const firstSpaceIndex = dateAndEvent.indexOf(' ');
    const accountId = message.account.account_id;
    const messageId = message.message_id;

    if (firstSpaceIndex > 0) {
      const dateStr = dateAndEvent.substring(0, firstSpaceIndex);
      const event = dateAndEvent.substring(firstSpaceIndex + 1);

      try {
        let formattedDate;
        const dateParts = dateStr.split('-');

        if (dateParts.length === 3) { // yyyy-mm-dd
          const year = parseInt(dateParts[0]);
          const month = parseInt(dateParts[1]);
          const day = parseInt(dateParts[2]);
          if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
            formattedDate = `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
          }
        } else if (dateParts.length === 2) { // mm-dd
          const month = parseInt(dateParts[0]);
          const day = parseInt(dateParts[1]);
          if (!isNaN(month) && !isNaN(day)) {
            formattedDate = `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
          }
        } else if (dateParts.length === 1) { // dd
          const day = parseInt(dateParts[0]);
          if (!isNaN(day)) {
            formattedDate = `${String(day).padStart(2, '0')}`;
          }
        }

        if (formattedDate) {
          await ChatworkBotUtils.addDateToList(formattedDate, event);
          await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}][pname:${accountId}]さん、${formattedDate} のイベント「${event}」を日付リストに登録しました。`);
        } else {
          await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}][pname:${accountId}]さん、日付の形式が正しくありません。「yyyy-mm-dd」「mm-dd」「dd」形式で入力してください。`);
        }
      } catch (e) {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}][pname:${accountId}]さん、日付の解析中にエラーが発生しました。`);
      }
    } else {
      await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}][pname:${accountId}]さん、コマンドの形式が正しくありません。「/day-write yyyy-mm-dd 〇〇の日」のように入力してください。`);
    }
  }

  static isUserAdmin(accountId, allMembers) {
    const user = allMembers.find(member => member.account_id === accountId);
    return user && user.role === 'admin';
  }

  static async writeToLog(roomId, userName, userId, messageBody, messageId) {
    try {
      const client = await pool.connect();
      await client.query(
        'INSERT INTO logs (room_id, user_name, user_id, message_body, message_id) VALUES ($1, $2, $3, $4, $5)',
        [roomId, userName, userId, messageBody, messageId]
      );
      client.release();
    } catch (error) {
      console.error('ログ書き込みエラー:', error.message);
    }
  }
}

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

      // 各ルームを処理
      for (const room of allRooms) {
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
          await new Promise(resolve => setTimeout(resolve, 2000)); // <== 2秒待機に変更

        } catch (error) {
          console.error(`ルーム ${roomId} (${roomName}) の処理中にエラー:`, error.message);
        }
      }

      console.log('=== Chatworkボット処理完了 ===');

    } catch (error) {
      console.error('Chatworkボット処理中にエラー:', error.message);
    }
  }

  // 日付変更メッセージ送信
  static async sendDailyGreetingMessage(roomId, roomName = '') {
    try {
      const now = new Date();
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();

      // 日本時間での0時0分をチェック（適宜調整）
      if (currentHour === 0 && currentMinute === 0) {
        const todayFormatted = now.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });

        // ルームIDごとに送信日を記録
        const lastSentDateKey = `lastDailyGreetingSentDate_${roomId}`;
        const lastSentDate = await ChatworkBotUtils.getProperty(lastSentDateKey);
        const todayDateOnly = now.toISOString().split('T')[0]; // YYYY-MM-DD形式

        if (lastSentDate !== todayDateOnly) {
          let message = `[info][title]日付変更！[/title]今日は${todayFormatted}だよ！`;

          const events = await ChatworkBotUtils.getTodaysEvents();
          if (events.length > 0) {
            events.forEach(event => {
              message += `\n今日は${event}だよ！`;
            });
          }

          message += `[/info]`;

          const success = await ChatworkBotUtils.sendChatworkMessage(roomId, message);
          if (success) {
            await ChatworkBotUtils.setProperty(lastSentDateKey, todayDateOnly);
            console.log(`日付変更メッセージを送信しました: ${roomName} (${roomId})`);
          }
        }
      }
    } catch (error) {
      console.error(`ルーム ${roomId} の日付変更メッセージ送信エラー:`, error.message);
    }
  }
}

// Express.jsのルート設定
app.use(express.json());

// ヘルスチェック用エンドポイント
app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Chatwork Bot is running',
    timestamp: new Date().toISOString(),
    database: 'PostgreSQL'
  });
});

// 手動実行用エンドポイント
app.post('/execute', async (req, res) => {
  try {
    await ChatworkBotMain.executeSingleCheck();
    res.json({ status: 'success', message: 'Bot executed successfully' });
  } catch (error) {
    console.error('手動実行エラー:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ステータス確認用エンドポイント
app.get('/status', async (req, res) => {
  try {
    const rooms = await ChatworkBotUtils.getAllParticipatingRooms();
    res.json({
      status: 'OK',
      roomCount: rooms.length,
      lastExecution: new Date().toISOString(),
      database: 'PostgreSQL',
      config: {
        roomConfigCount: Object.keys(ROOM_CONFIG).length,
        directChatWithDateChange: DIRECT_CHAT_WITH_DATE_CHANGE.length
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// データベーステスト用エンドポイント
app.get('/db-test', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW() as current_time');
    client.release();
    res.json({
      status: 'success',
      message: 'Database connection successful',
      current_time: result.rows[0].current_time
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ログ取得用エンドポイント
app.get('/logs/:roomId?', async (req, res) => {
  try {
    const { roomId } = req.params;
    const limit = parseInt(req.query.limit) || 100;

    const client = await pool.connect();
    let query = 'SELECT * FROM logs';
    let params = [];

    if (roomId) {
      query += ' WHERE room_id = $1 ORDER BY timestamp DESC LIMIT $2';
      params = [roomId, limit];
    } else {
      query += ' ORDER BY timestamp DESC LIMIT $1';
      params = [limit];
    }

    const result = await client.query(query, params);
    client.release();

    res.json({ status: 'success', logs: result.rows });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// 日付イベント取得用エンドポイント
app.get('/events', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT * FROM date_events ORDER BY date');
    client.release();
    res.json({ status: 'success', events: result.rows });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// メンバー情報取得用エンドポイント
app.get('/members/:roomId?', async (req, res) => {
  try {
    const { roomId } = req.params;
    const client = await pool.connect();

    let query = 'SELECT * FROM members';
    let params = [];

    if (roomId) {
      query += ' WHERE room_id = $1';
      params = [roomId];
    }

    query += ' ORDER BY join_time DESC';

    const result = await client.query(query, params);
    client.release();

    res.json({ status: 'success', members: result.rows });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// cron設定（15秒間隔でボット実行）
cron.schedule('*/15 * * * * *', async () => {
  console.log('定期実行開始:', new Date().toISOString());
  try {
    await ChatworkBotMain.executeSingleCheck();
  } catch (error) {
    console.error('定期実行エラー:', error.message);
  }
});

// サーバー起動
app.listen(port, () => {
  console.log(`Chatwork Bot server is running on port ${port}`);
  console.log('Environment variables:');
  console.log('- CHATWORK_API_TOKEN:', CHATWORK_API_TOKEN ? '設定済み' : '未設定');
  console.log('- DIRECT_CHAT_WITH_DATE_CHANGE:', DIRECT_CHAT_WITH_DATE_CHANGE);
  console.log('- DATABASE_URL:', process.env.DATABASE_URL ? '設定済み' : '未設定');
  console.log('- PORT:', port);

  // 初回実行
  setTimeout(async () => {
    console.log('初回実行を開始します...');
    try {
      await ChatworkBotMain.executeSingleCheck();
    } catch (error) {
      console.error('初回実行エラー:', error.message);
    }
  }, 5000);
});

// プロセス終了時のクリーンアップ
process.on('SIGINT', () => {
  console.log('サーバーを終了します...');
  pool.end(() => {
    console.log('PostgreSQL接続プールを終了しました。');
  });
  process.exit(0);
});

module.exports = app;
