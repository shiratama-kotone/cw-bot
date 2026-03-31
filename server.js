// Chatwork Bot for Render (WebHook版 - 全ルーム対応)
// server.js - 完全版（天気予報機能付き）

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

// データベース初期化（すべてのテーブル作成）
async function initializeDatabase() {
  try {
    // 既存のwebhooksテーブル
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

    // メッセージログテーブル (ルーム415060980のみ、1日保管)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS message_logs (
        id SERIAL PRIMARY KEY,
        room_id BIGINT NOT NULL,
        account_id BIGINT NOT NULL,
        message_body TEXT,
        send_time BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_message_logs_created ON message_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_message_logs_room ON message_logs(room_id);
    `);

    // 地雷トグル状態テーブル
    await pool.query(`
      CREATE TABLE IF NOT EXISTS jirai_toggles (
        id SERIAL PRIMARY KEY,
        toggle_name VARCHAR(50) UNIQUE NOT NULL,
        is_enabled BOOLEAN DEFAULT FALSE,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 初期データ挿入
    const toggles = ['gakusei', 'nyanko_a', 'milk', 'admin', 'yuyuyu'];
    for (const toggle of toggles) {
      await pool.query(
        'INSERT INTO jirai_toggles (toggle_name, is_enabled) VALUES ($1, $2) ON CONFLICT (toggle_name) DO NOTHING',
        [toggle, false]
      );
    }

    // アラームテーブル
    await pool.query(`
      CREATE TABLE IF NOT EXISTS alarms (
        id SERIAL PRIMARY KEY,
        room_id BIGINT NOT NULL,
        scheduled_time TIMESTAMP NOT NULL,
        message TEXT NOT NULL,
        created_by BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_alarms_scheduled ON alarms(scheduled_time);
    `);

    // 累計発言数テーブル
    await pool.query(`
      CREATE TABLE IF NOT EXISTS total_message_counts (
        id SERIAL PRIMARY KEY,
        room_id BIGINT NOT NULL,
        account_id BIGINT NOT NULL,
        message_count BIGINT DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(room_id, account_id)
      )
    `);

    // ブラックリストテーブル（TOALL・絵文字大量送信で閲覧になったユーザー）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS black_list (
        id SERIAL PRIMARY KEY,
        room_id BIGINT NOT NULL,
        account_id BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(room_id, account_id)
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_black_list_room_account ON black_list(room_id, account_id);
    `);

    console.log('データベーステーブル初期化完了');
  } catch (error) {
    console.error('データベース初期化エラー:', error.message);
  }
}

// データベースから地雷トグル状態を読み込み
async function loadJiraiToggles() {
  try {
    const result = await pool.query('SELECT toggle_name, is_enabled FROM jirai_toggles');
    const toggles = {};
    result.rows.forEach(row => {
      toggles[row.toggle_name] = row.is_enabled;
    });
    return toggles;
  } catch (error) {
    console.error('地雷トグル読み込みエラー:', error.message);
    return { gakusei: false, nyanko_a: false, milk: false, admin: false, yuyuyu: false };
  }
}

// 地雷トグル状態を保存
async function saveJiraiToggle(toggleName, isEnabled) {
  try {
    await pool.query(
      'UPDATE jirai_toggles SET is_enabled = $1, updated_at = NOW() WHERE toggle_name = $2',
      [isEnabled, toggleName]
    );
  } catch (error) {
    console.error('地雷トグル保存エラー:', error.message);
  }
}

// 環境変数から設定を読み込み
const CHATWORK_API_TOKEN = process.env.CHATWORK_API_TOKEN || '';
const INFO_API_TOKEN = process.env.INFO_API_TOKEN || '';
const DIRECT_CHAT_WITH_DATE_CHANGE = (process.env.DIRECT_CHAT_WITH_DATE_CHANGE || '405497983,407676893,415060980,406897783,391699365').split(',');
const LOG_ROOM_ID = '415060980'; // ウェルカムメッセージ&地雷の部屋（ログ送信元）
const LOG_DESTINATION_ROOM_ID = '420890621'; // ログ送信先
const DAY_JSON_URL = process.env.DAY_JSON_URL || 'https://raw.githubusercontent.com/shiratama-kotone/cw-bot/main/day.json';
const YUYUYU_ACCOUNT_ID = '10544705';
const BOT_ACCOUNT_ID = '10386947'; // botのアカウントID

// 天気予報の地域設定
const WEATHER_AREAS = [
  { name: 'さぽろー', code: '016010' },
  { name: 'おさかー', code: '270000' },
  { name: 'なごやー', code: '230010' },
  { name: 'ふくおかー', code: '400010' },
  { name: 'なはー', code: '471010' }
];

// メモリ内データストレージ
const memoryStorage = {
  properties: new Map(),
  lastSentDates: new Map(),
  messageCounts: new Map(),
  roomResetDates: new Map(),
  lastEarthquakeId: null,
  // ★ 地雷トグル状態
  toggles: {
    gakusei: false,
    nyanko_a: false,
    milk: false,
    admin: false,
    yuyuyu: false
  }
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
// ()なし（テキストそのまま）
const CHATWORK_EMOJI_NO_PAREN = [
  ':)', ':(', ':D', '8-)', ':o', ';)', ';(', ':|', ':*', ':p',
  ':^)', '|-)', ']:)', '8-|', ':#)', ':/'
];
// ()あり（囲まれた形式）
const CHATWORK_EMOJI_WITH_PAREN = [
  'sweat', 'blush', 'inlove', 'talk', 'yawn', 'puke', 'emo',
  'nod', 'shake', '^^;', 'whew', 'clap', 'bow', 'roger', 'flex', 'dance',
  'gogo', 'think', 'please', 'quick', 'anger', 'devil', 'lightbulb',
  '*', 'h', 'F', 'cracker', 'eat', '^', 'coffee', 'beer', 'handshake', 'y', 'ec14'
];

function escapeRegex(s) {
  return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}

const _noParenPart = CHATWORK_EMOJI_NO_PAREN.map(escapeRegex).join('|');
const _withParenPart = CHATWORK_EMOJI_WITH_PAREN.map(escapeRegex).join('|');
// ()なし絵文字 OR ()あり絵文字 の両方にマッチ
const CHATWORK_EMOJI_REGEX = new RegExp(
  `(?:${_noParenPart})|\\((${_withParenPart})\\)`,
  'g'
);

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
      console.log(`ログ送信: ルーム ${LOG_DESTINATION_ROOM_ID} へ`);
      await this.sendChatworkMessage(LOG_DESTINATION_ROOM_ID, logMessage);
      console.log(`ログ送信完了: ルーム ${LOG_DESTINATION_ROOM_ID}`);
    } catch (error) {
      console.error('Chatworkログ送信エラー:', error.message);
    }
  }

  static countChatworkEmojis(text) {
    const matches = text.match(CHATWORK_EMOJI_REGEX);
    return matches ? matches.length : 0;
  }

  static drawOmikuji(isAdmin) {
    const fortunes = ['大吉', '中吉', '吉', '小吉', '末吉', '凶', '凶', '凶'];
    const specialFortune = '湊音すぺしゃるっ！';
    let specialChance = 0.002;
    if (isAdmin) specialChance = 0.002;
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

  // ★ 地雷確率計算
  // 地雷確率計算（データベースから読み込み）
  static async getJiraiProbability(accountId, isSenderAdmin) {
    let probability = 0.0005; // 基本0.05%

    const toggles = await loadJiraiToggles();
    const id = String(accountId);

    console.log(`地雷確率計算: accountId=${id}, isAdmin=${isSenderAdmin}, toggles=${JSON.stringify(toggles)}`);

    if (toggles.gakusei && id === '9553691')  probability = Math.max(probability, 0.25);
    if (toggles.nyanko_a && id === '9487124') probability = Math.max(probability, 1.0);
    if (toggles.milk && id === '11092754')    probability = Math.max(probability, 0.50);
    if (toggles.admin && isSenderAdmin)       probability = Math.max(probability, 0.25);
    if (toggles.yuyuyu && id === '10911090')  probability = Math.max(probability, 0.75);

    console.log(`地雷最終確率: ${probability}`);
    return probability;
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
        headers: { 'User-Agent': 'ChatworkBot/1.0' }
      });

      const searchData = searchResponse.data;

      if (!searchData || !searchData[1] || searchData[1].length === 0) {
        const result = `「${searchTerm}」に関する記事は見つからなかったよ`;
        addToCache(cacheKey, { data: result, timestamp: now });
        return result;
      }

      const pageTitle = searchData[1][0];
      const pageUrl = searchData[3][0];

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
        headers: { 'User-Agent': 'ChatworkBot/1.0' }
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
          const result = `${summary}\n\n元記事は ${pageUrl} だよっ！`;
          addToCache(cacheKey, { data: result, timestamp: now });
          return result;
        }
      }

      const result = `「${searchTerm}」の情報を取得できなかったよ`;
      addToCache(cacheKey, { data: result, timestamp: now });
      return result;
    } catch (error) {
      console.error('Wikipedia検索エラー:', error.message);
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

      if (bio) {
        result += `[info][title]私について[/title]${bio}[/info]\n\n`;
      }

      if (status) {
        result += `[info][title]私が取り組んでいること[/title]${status}[/info]\n\n`;
      }

      if (!bio && !status) {
        result = `[info][title]Scratchユーザー情報[/title]ユーザー名: ${username}\nプロフィール情報がないよっ！[/info]\n\n`;
      }

      result += `ユーザーページ: ${userLink}`;

      return result;
    } catch (error) {
      if (error.response?.status === 404) {
        return `「${username}」というScratchユーザーは見つからなかったよ`;
      }
      return `Scratchユーザー情報の取得してるときに予期してなかったエラーが起こっちゃった。`;
    }
  }

  static async getScratchProjectInfo(projectId) {
    try {
      await apiCallLimiter();
      const response = await axios.get(`https://api.scratch.mit.edu/projects/${projectId}`);
      const data = response.data;
      if (!data || !data.title) {
        return 'プロジェクトが見つからなかったよ';
      }
      const url = `https://scratch.mit.edu/projects/${projectId}/`;
      return `[info][title]Scratchプロジェクト情報[/title]タイトル: ${data.title}\n作者: ${data.author.username}\n説明: ${data.description || '説明なし'}\nURL: ${url}[/info]`;
    } catch (error) {
      return 'Scratchプロジェクト情報の取得中にエラーが発生したよ';
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
        const titleMain = $('h2.newLyricTitle__main').text().trim();
        const titleAfter = $('span.newLyricTitle_afterTxt').text().trim();
        title = titleMain.replace(titleAfter, '').trim();

        $('div.hiragana span.rt').remove();

        lyrics = $('div.hiragana').html() || '';

        lyrics = lyrics.replace(/<br\s*\/?>/gi, '\n')
                      .replace(/<[^>]+>/g, '')
                      .trim();

      } else if (url.includes('uta-net.com')) {
        title = $('h2.ms-2.ms-md-3.kashi-title').text().trim();

        lyrics = $('div#kashi_area[itemprop="text"]').html() || '';

        lyrics = lyrics.replace(/<br\s*\/?>/gi, '\n')
                      .replace(/<[^>]+>/g, '')
                      .trim();
      } else if (url.includes('atwiki.jp')) {
        // @wikiの処理
        // 曲名を「曲紹介」セクションから取得
        const songIntroH3 = $('h3:contains("曲紹介")');
        if (songIntroH3.length > 0) {
          let currentElement = songIntroH3.next();
          while (currentElement.length > 0 && !currentElement.is('h3')) {
            const text = currentElement.text();
            const match = text.match(/曲名：[『「]?(.+?)[』」]?[（(]/);
            if (match) {
              title = match[1].replace(/<u>|<\/u>/g, '').trim();
              break;
            }
            currentElement = currentElement.next();
          }
        }

        // タイトルが見つからなければページタイトルから取得
        if (!title) {
          title = $('title').text().trim();
          if (title.includes(' - ')) {
            title = title.split(' - ')[0].trim();
          }
        }

        // 歌詞セクションを抽出
        const lyricsStart = $('h3:contains("歌詞")');
        const relatedStart = $('h3:contains("関連動画")');

        if (lyricsStart.length === 0) {
          return '歌詞セクションが見つからなかったよ';
        }

        // 歌詞セクションと関連動画セクションの間のdivを取得
        let lyricsHtml = '';
        let currentElement = lyricsStart.next();

        while (currentElement.length > 0) {
          if (currentElement.is('h3') && currentElement.text().includes('関連動画')) {
            break;
          }
          if (currentElement.is('div') || currentElement.is('br')) {
            lyricsHtml += $.html(currentElement);
          }
          currentElement = currentElement.next();
        }

        // HTMLを整形
        lyrics = lyricsHtml
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<div>/gi, '')
          .replace(/<\/div>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

      } else {
        return '対応していないURLだよっ！utaten.com、uta-net.com、またはatwiki.jpのURLを指定してねっ！';
      }

      if (!title || !lyrics) {
        return '歌詞の取得に失敗しちゃった。URLを確認してくれるとうれしいな';
      }

      return `[info][title]${title}の歌詞だよっ！[/title]${lyrics}[/info]`;
    } catch (error) {
      console.error('歌詞取得エラー:', error.message);
      return `歌詞の取得中にエラーが発生しちゃった: ${error.message}`;
    }
  }

  // 歌詞タイピング情報取得
  static async getSongTypingInfo(songId) {
    try {
      const response = await axios.get(
        'https://shiratama-kotone.github.io/typing-game/song-typing/lyrics-data.js',
        { timeout: 10000 }
      );

      const jsCode = response.data;

      // lyricsDataを抽出（正規表現で安全に）
      const match = jsCode.match(/(?:const|var|let)\s+lyricsData\s*=\s*(\[[\s\S]*\])\s*;/);
      if (!match) {
        return '歌詞データの解析に失敗しちゃった';
      }

      // JSONとして評価（安全にパース）
      let lyricsData;
      try {
        // Function constructorを使って安全にコードを実行
        const func = new Function(`return ${match[1]};`);
        lyricsData = func();
      } catch (e) {
        return '歌詞データの解析に失敗しちゃった';
      }

      // 曲IDで検索（同IDが複数ある場合も全部出す）
      const songs = lyricsData.filter(s => s.id === songId);
      if (songs.length === 0) {
        return `曲ID「${songId}」が見つからなかったよ`;
      }

      const results = [];
      for (const song of songs) {
        // 総打数計算
        let totalCount = 0;
        song.lyrics.forEach(line => {
          totalCount += line.kana.length;
        });

        // ライン数
        const lineCount = song.lyrics.length;

        // YouTubeから動画の長さを取得
        let duration = '取得中...';
        try {
          const ytResponse = await axios.get(
            `https://www.youtube.com/watch?v=${song.youtubeId}`,
            { timeout: 5000 }
          );
          const durationMatch = ytResponse.data.match(/"lengthSeconds":"(\d+)"/);
          if (durationMatch) {
            const seconds = parseInt(durationMatch[1]);
            const minutes = Math.floor(seconds / 60);
            const secs = seconds % 60;
            duration = `${minutes}:${String(secs).padStart(2, '0')}`;
          }
        } catch (e) {
          duration = '取得失敗';
        }

        // 必要平均タイプ速度計算（打/秒）
        let avgSpeed = '計算中...';
        if (duration !== '取得中...' && duration !== '取得失敗') {
          const [min, sec] = duration.split(':').map(Number);
          const totalSeconds = min * 60 + sec;
          avgSpeed = `${(totalCount / totalSeconds).toFixed(2)}打/秒`;
        }

        results.push(`[info][title]${song.title}の歌詞タイピング情報[/title]総打数：${totalCount}\n曲の長さ：${duration}\n必要平均タイプ速度：${avgSpeed}\nライン数：${lineCount}[/info]`);
      }

      return results.join('\n');
    } catch (error) {
      console.error('歌詞タイピング情報取得エラー:', error.message);
      return `歌詞タイピング情報の取得中にエラーが発生しちゃった: ${error.message}`;
    }
  }

  // 天気予報取得
  static async getWeatherForecast(areaCode) {
    try {
      const response = await axios.get(`https://weather.tsukumijima.net/api/forecast/city/${areaCode}`, {
        timeout: 10000
      });

      return response.data;
    } catch (error) {
      console.error(`天気予報取得エラー (${areaCode}):`, error.message);
      return null;
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

  // 累計発言数をデータベースとAPIから初期化
  static async initializeTotalMessageCounts(roomId) {
    try {
      console.log(`ルーム ${roomId} の累計発言数を初期化中...`);

      // まずデータベースから既存のwebhooksデータを集計
      const dbResult = await pool.query(
        'SELECT account_id, COUNT(*) as count FROM webhooks WHERE room_id = $1 AND webhook_event_type = $2 GROUP BY account_id',
        [roomId, 'message_created']
      );

      const counts = {};
      dbResult.rows.forEach(row => {
        counts[row.account_id] = parseInt(row.count);
      });

      // データベースに保存
      for (const [accountId, count] of Object.entries(counts)) {
        await pool.query(`
          INSERT INTO total_message_counts (room_id, account_id, message_count)
          VALUES ($1, $2, $3)
          ON CONFLICT (room_id, account_id)
          DO UPDATE SET message_count = GREATEST(total_message_counts.message_count, $3), updated_at = NOW()
        `, [roomId, accountId, count]);
      }

      const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);
      console.log(`ルーム ${roomId} 累計発言数初期化完了: ${totalCount}件`);

      return counts;
    } catch (error) {
      console.error(`ルーム ${roomId} の累計発言数初期化エラー:`, error.message);
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

  static async deleteMessage(roomId, messageId) {
    await apiCallLimiter();
    try {
      await axios.delete(
        `https://api.chatwork.com/v2/rooms/${roomId}/messages/${messageId}`,
        { headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN } }
      );
      console.log(`メッセージ削除成功: ${roomId}/${messageId}`);
      return true;
    } catch (error) {
      console.error(`メッセージ削除エラー (${roomId}/${messageId}):`, error.message);
      return false;
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

      if (!earthquake.earthquake || earthquake.earthquake.maxScale < 10) {
        return null;
      }

      const targetRegions = ['福岡', '北海道', '大阪'];
      let shouldNotify = false;

      if (earthquake.earthquake.maxScale >= 30) {
        shouldNotify = true;
      } else {
        if (earthquake.earthquake.points && Array.isArray(earthquake.earthquake.points)) {
          shouldNotify = earthquake.earthquake.points.some(point => {
            if (point.scale >= 10) {
              return targetRegions.some(region => {
                const prefName = point.pref || '';
                const addrName = point.addr || '';
                return prefName.includes(region) || addrName.includes(region);
              });
            }
            return false;
          });
        }

        if (!shouldNotify && earthquake.earthquake.hypocenter) {
          const hypocenterName = earthquake.earthquake.hypocenter.name || '';
          shouldNotify = targetRegions.some(region => hypocenterName.includes(region));
        }
      }

      if (!shouldNotify) {
        return null;
      }

      return {
        id: earthquake.id,
        time: earthquake.earthquake.time,
        hypocenter: earthquake.earthquake.hypocenter && earthquake.earthquake.hypocenter.name ? earthquake.earthquake.hypocenter.name : null,
        magnitude: earthquake.earthquake.hypocenter ? earthquake.earthquake.hypocenter.magnitude : null,
        maxScale: earthquake.earthquake.maxScale,
        points: earthquake.earthquake.points || []
      };
    } catch (error) {
      console.error('地震情報取得エラー:', error.message);
      return null;
    }
  }

  static async notifyEarthquake(earthquakeInfo, isTest = false) {
    try {
      const scaleMap = {
        10: '1', 20: '2', 30: '3', 40: '4',
        45: '5弱', 50: '5強', 55: '6弱', 60: '6強', 70: '7'
      };
      const scale = scaleMap[earthquakeInfo.maxScale] || (earthquakeInfo.maxScale / 10);

      const earthquakeDate = new Date(earthquakeInfo.time);
      const year = earthquakeDate.getFullYear();
      const month = String(earthquakeDate.getMonth() + 1).padStart(2, '0');
      const day = String(earthquakeDate.getDate()).padStart(2, '0');
      const hours = String(earthquakeDate.getHours()).padStart(2, '0');
      const minutes = String(earthquakeDate.getMinutes()).padStart(2, '0');

      const title = isTest ? '地震情報-テストだよ' : '地震情報だよ';
      const magnitudeText = (earthquakeInfo.magnitude === null || earthquakeInfo.magnitude === -1 || earthquakeInfo.magnitude === undefined) ? 'まだわかんない' : earthquakeInfo.magnitude;

      let message;
      if (!earthquakeInfo.hypocenter || earthquakeInfo.hypocenter === '' || earthquakeInfo.hypocenter === '不明') {
        message = `[info][title]${title}[/title]${year}年${month}月${day}日 ${hours}:${minutes} に震度${scale}の地震が発生したよ。\nマグニチュードは${magnitudeText}\n引き続き情報に注意してね！[/info]`;
      } else {
        message = `[info][title]${title}[/title]${year}年${month}月${day}日 ${hours}:${minutes} に ${earthquakeInfo.hypocenter} で震度${scale}の地震が発生したよ。\nマグニチュードは${magnitudeText}\n引き続き情報に注意してね！[/info]`;
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
      console.log(`メンバー取得成功 (${roomId}): ${response.data.length}人`);
      return response.data.map(member => ({
        account_id: member.account_id,
        name: member.name,
        role: member.role
      }));
    } catch (error) {
      console.error(`メンバー取得エラー (${roomId}):`, error.message, error.response?.status);
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

  // ★ ブラックリスト追加
  static async addToBlackList(roomId, accountId) {
    try {
      await pool.query(
        'INSERT INTO black_list (room_id, account_id) VALUES ($1, $2) ON CONFLICT (room_id, account_id) DO NOTHING',
        [roomId, accountId]
      );
      console.log(`ブラックリスト追加: roomId=${roomId}, accountId=${accountId}`);
    } catch (error) {
      console.error('ブラックリスト追加エラー:', error.message);
    }
  }

  // ★ ブラックリスト確認
  static async isInBlackList(roomId, accountId) {
    try {
      const result = await pool.query(
        'SELECT 1 FROM black_list WHERE room_id = $1 AND account_id = $2',
        [roomId, accountId]
      );
      return result.rowCount > 0;
    } catch (error) {
      console.error('ブラックリスト確認エラー:', error.message);
      return false;
    }
  }

  // ★ 指定ユーザーを閲覧のみに強制変更（ブラックリスト用）
  static async forceReadOnly(roomId, targetAccountId, currentMembers) {
    try {
      const admins   = currentMembers.filter(m => m.role === 'admin').map(m => String(m.account_id));
      const members  = currentMembers.filter(m => m.role === 'member' && String(m.account_id) !== String(targetAccountId)).map(m => String(m.account_id));
      const readonly = currentMembers.filter(m => m.role === 'readonly').map(m => String(m.account_id));
      if (!readonly.includes(String(targetAccountId))) readonly.push(String(targetAccountId));

      const params = new URLSearchParams();
      if (admins.length   > 0) params.append('members_admin_ids',    admins.join(','));
      if (members.length  > 0) params.append('members_member_ids',   members.join(','));
      if (readonly.length > 0) params.append('members_readonly_ids', readonly.join(','));

      await apiCallLimiter();
      await axios.put(
        `https://api.chatwork.com/v2/rooms/${roomId}/members`,
        params,
        { headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN } }
      );
      console.log(`ブラックリスト: 閲覧のみに強制変更: roomId=${roomId}, accountId=${targetAccountId}`);
      return true;
    } catch (error) {
      console.error('ブラックリスト強制閲覧変更エラー:', error.message);
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

  // メッセージログをデータベースに保存（ルーム415060980のみ、編集は除外）
  static async saveMessageLog(webhookData) {
    try {
      const roomId = String(webhookData.room_id);
      const eventType = webhookData.webhook_event_type || 'message_created';

      // ルーム415060980のみ、かつ新規メッセージのみ
      if (roomId !== LOG_ROOM_ID || eventType !== 'message_created') {
        return;
      }

      const accountId = webhookData.account_id;
      const messageBody = webhookData.body || '';
      const sendTime = webhookData.send_time;

      await pool.query(
        'INSERT INTO message_logs (room_id, account_id, message_body, send_time) VALUES ($1, $2, $3, $4)',
        [roomId, accountId, messageBody, sendTime]
      );

      console.log(`メッセージログ保存: ルーム ${roomId}, アカウント ${accountId}`);
    } catch (error) {
      console.error('メッセージログ保存エラー:', error.message);
    }
  }

  // 累計発言数を更新
  static async updateTotalMessageCount(roomId, accountId) {
    try {
      await pool.query(`
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

      console.log(`WebHook処理開始: roomId=${roomId}, accountId=${accountId}, eventType=${eventType}, messageLength=${messageBody?.length || 0}`);

      // 新規メッセージのみ累計発言数を更新
      if (eventType === 'message_created') {
        await this.updateTotalMessageCount(roomId, accountId);
      }

      let userName = '';

      if (!roomId || !accountId || !messageBody) {
        console.log('不完全なWebHookデータ:', webhookData);
        return;
      }

      // ★★★ 転送処理 ★★★
      if (roomId === '415060980' || roomId === 415060980) {
        const forwardRoomId = '420890621';
        const eventType = webhookData.webhook_event_type || 'message_created';

        const editLabel = eventType === 'message_updated' ? '(編集)' : '';
        const forwardMessage = `[info][title][piconname:${accountId}]${editLabel}[/title]${messageBody}[/info]`;

        try {
          await ChatworkBotUtils.sendChatworkMessage(forwardRoomId, forwardMessage);
          console.log(`メッセージ転送完了 [${eventType}]: ${roomId} → ${forwardRoomId}`);
        } catch (error) {
          console.error(`メッセージ転送エラー (${roomId} → ${forwardRoomId}):`, error.message);
        }
      }

      // ★★★ ウェルカムメッセージ & ブラックリスト再参加チェック ★★★
      if (messageBody.includes('[dtext:chatroom_member_is]') && 
          messageBody.includes('[dtext:chatroom_added]')) {

        const piconnameMatch = messageBody.match(/\[piconname:(\d+)\]/);

        if (piconnameMatch && piconnameMatch[1]) {
          const newUserId = piconnameMatch[1];

          // ブラックリストチェック
          const isBlacklisted = await ChatworkBotUtils.isInBlackList(String(roomId), newUserId);
          if (isBlacklisted) {
            console.log(`ブラックリストユーザー再参加検知: roomId=${roomId}, accountId=${newUserId}`);
            await new Promise(resolve => setTimeout(resolve, 1500));
            const freshMembers = await ChatworkBotUtils.getChatworkMembers(roomId);
            await ChatworkBotUtils.forceReadOnly(roomId, newUserId, freshMembers);
            await ChatworkBotUtils.sendChatworkMessage(roomId,
              `[To:${newUserId}][pname:${newUserId}]ちゃんはブラックリストに入ってるから閲覧のみにしたよ`);
          } else if (String(roomId) === LOG_ROOM_ID || roomId === LOG_ROOM_ID) {
            // ウェルカムメッセージ（LOG_ROOM_IDのみ）
            const welcomeMessage = `[To:${newUserId}][pname:${newUserId}]ちゃん\nこの部屋へようこそ！\nこの部屋は色々とおかしいけどよろしくね！`;
            try {
              await new Promise(resolve => setTimeout(resolve, 1000));
              await ChatworkBotUtils.sendChatworkMessage(roomId, welcomeMessage);
              console.log(`ウェルカムメッセージ送信完了: ユーザー ${newUserId}`);
            } catch (error) {
              console.error('ウェルカムメッセージ送信エラー:', error.message);
            }
          }
        }
      }

      // ★★★ 権限変更でブラックリストチェック ★★★
      if (messageBody.includes('[dtext:chatroom_member_is]') &&
          messageBody.includes('[dtext:chatroom_priv_changed]')) {

        const piconnameMatch = messageBody.match(/\[piconname:(\d+)\]/);
        if (piconnameMatch && piconnameMatch[1]) {
          const changedUserId = piconnameMatch[1];
          const isBlacklisted = await ChatworkBotUtils.isInBlackList(String(roomId), changedUserId);
          if (isBlacklisted) {
            console.log(`ブラックリストユーザー権限変更検知: roomId=${roomId}, accountId=${changedUserId}`);
            await new Promise(resolve => setTimeout(resolve, 1500));
            const freshMembers = await ChatworkBotUtils.getChatworkMembers(roomId);
            const member = freshMembers.find(m => String(m.account_id) === String(changedUserId));
            if (member && member.role !== 'readonly') {
              await ChatworkBotUtils.forceReadOnly(roomId, changedUserId, freshMembers);
              await ChatworkBotUtils.sendChatworkMessage(roomId,
                `[pname:${changedUserId}]ちゃんはブラックリストに入ってるから閲覧のみに戻したよ`);
            }
          }
        }
      }

      // メッセージカウント更新
      this.updateMessageCount(roomId, accountId);

      // ログ送信
      console.log(`ログ送信チェック: sourceRoomId=${roomId}, LOG_ROOM_ID=${LOG_ROOM_ID}`);
      await ChatworkBotUtils.sendLogToChatwork(userName, messageBody, roomId);

      // メンバー情報取得
      let currentMembers = [];
      let isSenderAdmin = true;
      const isDirectChat = webhookData.room_type === 'direct';

      if (!isDirectChat) {
        currentMembers = await ChatworkBotUtils.getChatworkMembers(roomId);
        isSenderAdmin = this.isUserAdmin(accountId, currentMembers);
      }

      // userName解決（WebhookのaccountオブジェクトかメンバーリストかAPIから取得）
      if (account && account.name) {
        userName = account.name;
      } else {
        const memberInfo = currentMembers.find(m => String(m.account_id) === String(accountId));
        userName = memberInfo ? memberInfo.name : `ID:${accountId}`;
      }

      // ★★★ 地雷踏んだね (LOG_ROOM_IDのみ) ★★★
      console.log(`地雷チェック: roomId=${roomId} (型=${typeof roomId}), LOG_ROOM_ID=${LOG_ROOM_ID} (型=${typeof LOG_ROOM_ID}), 一致=${String(roomId) === LOG_ROOM_ID}`);
      if (String(roomId) === LOG_ROOM_ID) {
        console.log(`地雷処理開始: accountId=${accountId}, isAdmin=${isSenderAdmin}`);

        // トグル状態を確認
        const toggles = await loadJiraiToggles();
        console.log(`地雷トグル状態: ${JSON.stringify(toggles)}`);

        const jiraiProb = await ChatworkBotUtils.getJiraiProbability(accountId, isSenderAdmin);
        console.log(`地雷確率: ${jiraiProb} (${(jiraiProb * 100).toFixed(2)}%) accountId=${accountId}, isAdmin=${isSenderAdmin}`);
        const rand = Math.random();
        console.log(`地雷判定: rand=${rand}, prob=${jiraiProb}, 発動=${rand < jiraiProb}`);
        if (rand < jiraiProb) {
          console.log(`地雷発動！管理者を選択中...`);
          // 管理者からランダムに1人選ぶ
          const admins = currentMembers.filter(m => m.role === 'admin');
          console.log(`管理者数: ${admins.length}, 全メンバー数: ${currentMembers.length}`);

          if (admins.length === 0) {
            console.error('管理者が見つかりません！');
            return;
          }

          const randomAdmin = admins[Math.floor(Math.random() * admins.length)];
          const adminId = randomAdmin.account_id;
          const adminName = randomAdmin.name;

          console.log(`選ばれた管理者: ${adminName} (ID: ${adminId})`);

          const jiraiMsg = `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\n地雷ふんじゃったね…\n[To:${adminId}]${adminName}に罰ゲームを考えてもらってね！`;
          await ChatworkBotUtils.sendChatworkMessage(roomId, jiraiMsg);
          console.log(`地雷踏んだね送信完了: roomId=${roomId}, accountId=${accountId}, 選ばれた管理者=${adminName}`);
        } else {
          console.log(`地雷不発: rand=${rand} >= prob=${jiraiProb}`);
        }
      } else {
        console.log(`地雷チェックスキップ: roomId=${roomId}はLOG_ROOM_ID(${LOG_ROOM_ID})ではありません`);
      }

      // コマンド処理
      await this.handleCommands(
        roomId,
        messageId,
        accountId,
        (messageBody || '').trim(),
        isSenderAdmin,
        isDirectChat,
        currentMembers,
        userName
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

  static async handleCommands(roomId, messageId, accountId, messageBody, isSenderAdmin, isDirectChat, currentMembers, userName) {
    // TOALL検出（非管理者のみ、権限を閲覧のみに変更）
    if (!isDirectChat && messageBody.toLowerCase().includes('toall') && !isSenderAdmin) {
      console.log(`TOALLを検出した非管理者: ${accountId} in room ${roomId}`);

      // 警告メッセージ送信
      const warningMsg = `[info]TOALLを検知したよ！\nフィルターが作動するよ！[/info]`;
      await ChatworkBotUtils.sendChatworkMessage(roomId, warningMsg);

      // 権限を閲覧のみに変更
      try {
        const admins = currentMembers.filter(m => m.role === 'admin').map(m => String(m.account_id));
        const members = currentMembers.filter(m => m.role === 'member' && String(m.account_id) !== String(accountId)).map(m => String(m.account_id));
        const readonly = currentMembers.filter(m => m.role === 'readonly').map(m => String(m.account_id));
        readonly.push(String(accountId));

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

        console.log(`TOALL使用者を閲覧のみに変更: ${accountId} in room ${roomId}`);
        await ChatworkBotUtils.addToBlackList(roomId, accountId);
      } catch (error) {
        console.error('権限変更エラー:', error.message);
      }
    }

    // 歌詞取得コマンド
    if (messageBody.startsWith('/lyric ')) {
      const url = messageBody.substring('/lyric '.length).trim();
      if (url && (url.includes('utaten.com') || url.includes('uta-net.com') || url.includes('atwiki.jp'))) {
        const lyrics = await ChatworkBotUtils.getLyrics(url);
        const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}]${lyrics}`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, replyMessage);
      } else {
        const errorMessage = `[rp aid=${accountId} to=${roomId}-${messageId}]\nつかいかたは /lyric {utaten.com、uta-net.com、またはatwiki.jpのURL} だよ`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, errorMessage);
      }
      return;
    }

    // ★★★ Botメッセージ削除機能 ★★★
    const deleteKeywords = ['削除', 'delete', '/del', 'けして'];
    if (deleteKeywords.some(keyword => messageBody.includes(keyword))) {
      // 返信先メッセージIDを抽出
      const rpMatch = messageBody.match(/\[rp aid=(\d+) to=(\d+)-(\d+)\]/);
      if (rpMatch) {
        const targetMessageId = rpMatch[3];
        // メッセージを取得して送信者を確認
        const targetMessage = await ChatworkBotUtils.getMessage(roomId, targetMessageId);
        if (targetMessage && String(targetMessage.account.account_id) === BOT_ACCOUNT_ID) {
          // Botのメッセージなら削除
          const deleted = await ChatworkBotUtils.deleteMessage(roomId, targetMessageId);
          if (deleted) {
            console.log(`Botメッセージ削除成功: ${targetMessageId}`);
          }
        }
      }
    }

    // ★★★ /song-typing-info コマンド ★★★
    if (messageBody.startsWith('/song-typing-info ')) {
      const songId = messageBody.substring('/song-typing-info '.length).trim();
      if (songId) {
        const info = await ChatworkBotUtils.getSongTypingInfo(songId);
        const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}]${info}`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, replyMessage);
      } else {
        const errorMessage = `[rp aid=${accountId} to=${roomId}-${messageId}]\nつかいかたは /song-typing-info {曲ID} だよ`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, errorMessage);
      }
      return;
    }

    // ★★★ /alarm コマンド ★★★
    if (messageBody.startsWith('/alarm ')) {
      const argsPart = messageBody.substring('/alarm '.length).trim();
      const match = argsPart.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s+(.+)$/);

      if (!match) {
        const errorMsg = `[rp aid=${accountId} to=${roomId}-${messageId}]使い方: /alarm YYYY-MM-DD HH:MM メッセージ内容\n例: /alarm 2026-03-23 23:30 おやすみ！`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, errorMsg);
        return;
      }

      const [, date, time, message] = match;
      const scheduledTime = new Date(`${date}T${time}:00+09:00`);

      try {
        await pool.query(
          'INSERT INTO alarms (room_id, scheduled_time, message, created_by) VALUES ($1, $2, $3, $4)',
          [roomId, scheduledTime, message, accountId]
        );

        const confirmMsg = `[rp aid=${accountId} to=${roomId}-${messageId}]アラームを設定したよ！\n${scheduledTime.toLocaleString('ja-JP', {timeZone: 'Asia/Tokyo'})} に「${message}」を送信するね`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, confirmMsg);
      } catch (error) {
        console.error('アラーム設定エラー:', error.message);
        const errorMsg = `[rp aid=${accountId} to=${roomId}-${messageId}]アラーム設定に失敗しちゃった: ${error.message}`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, errorMsg);
      }
      return;
    }

    // ★★★ /message-total コマンド ★★★
    if (messageBody === '/message-total') {
      try {
        const result = await pool.query(
          'SELECT account_id, message_count FROM total_message_counts WHERE room_id = $1 ORDER BY message_count DESC',
          [roomId]
        );

        if (result.rows.length === 0) {
          const msg = `[rp aid=${accountId} to=${roomId}-${messageId}]この部屋の累計発言数はまだないみたい`;
          await ChatworkBotUtils.sendChatworkMessage(roomId, msg);
          return;
        }

        let rankingMessage = '[info][title]累計発言数ランキング[/title]\n';
        result.rows.forEach((row, index) => {
          rankingMessage += `${index + 1}位：[piconname:${row.account_id}] ${row.message_count}コメ`;
          if (index < result.rows.length - 1) {
            rankingMessage += '\n[hr]';
          }
          rankingMessage += '\n';
        });

        const totalCount = result.rows.reduce((sum, row) => sum + parseInt(row.message_count), 0);
        rankingMessage += `\n合計：${totalCount}コメ[/info]`;

        const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}]${rankingMessage}`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, replyMessage);
      } catch (error) {
        console.error('累計発言数取得エラー:', error.message);
      }
      return;
    }

    if (messageBody === 'おみくじ') {
      const omikujiResult = ChatworkBotUtils.drawOmikuji(isSenderAdmin);
      const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん[info][title]おみくじ[/title]おみくじの結果は…\n\n${omikujiResult}\n\nだよっ！[/info]`;
      await ChatworkBotUtils.sendChatworkMessage(roomId, replyMessage);
    }

    // Chatwork絵文字カウント警告（非管理者のみ、権限を閲覧のみに変更）
    if (!isDirectChat) {
      const emojiCount = ChatworkBotUtils.countChatworkEmojis(messageBody);
      console.log(`絵文字カウント: ${emojiCount}個 (roomId=${roomId}, accountId=${accountId}, isAdmin=${isSenderAdmin})`);
      if (emojiCount >= 50 && !isSenderAdmin) {
        // 警告メッセージ送信
        const warningMessage = `[info]Chatworkの絵文字を${emojiCount}個検知したよ！\nフィルターが作動するよ！[/info]`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, warningMessage);

        // 権限を閲覧のみに変更
        try {
          const admins = currentMembers.filter(m => m.role === 'admin').map(m => String(m.account_id));
          const members = currentMembers.filter(m => m.role === 'member' && String(m.account_id) !== String(accountId)).map(m => String(m.account_id));
          const readonly = currentMembers.filter(m => m.role === 'readonly').map(m => String(m.account_id));
          readonly.push(String(accountId));

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

          console.log(`絵文字多用者を閲覧のみに変更: ${accountId} in room ${roomId}`);
          await ChatworkBotUtils.addToBlackList(roomId, accountId);
        } catch (error) {
          console.error('権限変更エラー:', error.message);
        }
      }
    }

    if (messageBody === '/yes-or-no') {
      const answer = await ChatworkBotUtils.getYesOrNoAnswer();
      const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\n答えは「${answer}」だよっ！`;
      await ChatworkBotUtils.sendChatworkMessage(roomId, replyMessage);
    }

    if (messageBody.startsWith('/wiki ')) {
      const searchTerm = messageBody.substring('/wiki '.length).trim();
      if (searchTerm) {
        const wikipediaSummary = await ChatworkBotUtils.getWikipediaSummary(searchTerm);
        const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\nWikipediaの検索結果だよっ！\n\n${wikipediaSummary}`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, replyMessage);
      } else {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]つかいかたは /wiki 検索ワード だよ`);
      }
      return;
    }

    if (messageBody.startsWith('/info ')) {
      const targetRoomId = messageBody.substring('/info '.length).trim();

      if (!targetRoomId || !INFO_API_TOKEN) {
        const errorMsg = !INFO_API_TOKEN
          ? 'ズモモエラー！！ChatworkAPIのエラーが出たぞ！ますたー！対応しろ！'
          : 'ルームIDを指定してくれるとうれしいな';
        await ChatworkBotUtils.sendChatworkMessage(roomId,
          `[rp aid=${accountId} to=${roomId}-${messageId}]${errorMsg}`);
        return;
      }

      const canUseInfoCommand = isDirectChat ? true : isSenderAdmin;

      if (!canUseInfoCommand) {
        await ChatworkBotUtils.sendChatworkMessage(roomId,
          `[rp aid=${accountId} to=${roomId}-${messageId}]このコマンドは管理者だけが使えるよ`);
        return;
      }

      try {
        const roomInfo = await ChatworkBotUtils.getRoomInfoWithToken(targetRoomId, INFO_API_TOKEN);

        if (roomInfo.error === 'not_found') {
          await ChatworkBotUtils.sendChatworkMessage(roomId,
            `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\n存在しないルームかも。`);
          return;
        }

        if (roomInfo.error) {
          await ChatworkBotUtils.sendChatworkMessage(roomId,
            `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\nルーム情報持ってくるのに失敗しちゃった。`);
          return;
        }

        const members = await ChatworkBotUtils.getRoomMembersWithToken(targetRoomId, INFO_API_TOKEN);

        const yuyuyuId = String(YUYUYU_ACCOUNT_ID);
        const isYuyuyuMember = members.some(m => String(m.account_id) === yuyuyuId);

        console.log(`/info チェック: ルーム ${targetRoomId}, メンバー数 ${members.length}, ゆゆゆ参加: ${isYuyuyuMember}, DM: ${isDirectChat}`);

        if (!isYuyuyuMember) {
          await ChatworkBotUtils.sendChatworkMessage(roomId,
            `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\nますたーが参加してないかも。`);
          return;
        }

        const roomName     = roomInfo.name;
        const memberCount  = members.length;
        const adminCount   = members.filter(m => m.role === 'admin').length;
        const fileCount    = roomInfo.file_num    || 0;
        const messageCount = roomInfo.message_num || 0;
        const iconPath     = roomInfo.icon_path   || '';

        let iconLink = 'なし';
        if (iconPath) {
          iconLink = iconPath.startsWith('http')
            ? iconPath
            : `https://appdata.chatwork.com${iconPath}`;
        }

        const admins = members.filter(m => m.role === 'admin');
        const adminList = admins.length > 0
          ? admins.map(admin => `[picon:${admin.account_id}]`).join(' ')
          : 'なし';

        const infoMessage =
          `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\n` +
          `[info][title]${roomName}の情報だよっ！[/title]` +
          `部屋名：${roomName}\n` +
          `メンバー数：${memberCount}人\n` +
          `管理者数：${adminCount}人\n` +
          `ルームID：${targetRoomId}\n` +
          `ファイル数：${fileCount}\n` +
          `メッセージ数：${messageCount}\n` +
          `アイコン：${iconLink}\n` +
          `管理者一覧：${adminList}[/info]`;

        await ChatworkBotUtils.sendChatworkMessage(roomId, infoMessage);
      } catch (error) {
        console.error('ルーム情報取得エラー:', error.message);
        await ChatworkBotUtils.sendChatworkMessage(roomId,
          `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\nルーム情報の取得中にエラーが発生しちゃった: ${error.message}`);
      }
      return;
    }

    if (messageBody.startsWith('/scratch-user ')) {
      const username = messageBody.substring('/scratch-user '.length).trim();
      if (username) {
        const userStats = await ChatworkBotUtils.getScratchUserStats(username);
        const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\nScratchのユーザー「${username}」の情報だよっ！\n\n${userStats}`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, replyMessage);
      } else {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]つかいかたは /scratch-user ユーザー名 だよ`);
      }
      return;
    }

    if (messageBody.startsWith('/scratch-project ')) {
      const projectId = messageBody.substring('/scratch-project '.length).trim();
      if (projectId) {
        const projectInfo = await ChatworkBotUtils.getScratchProjectInfo(projectId);
        const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\nScratchの作品「${projectId}」の情報だよっ！\n\n${projectInfo}`;
        await ChatworkBotUtils.sendChatworkMessage(roomId, replyMessage);
      } else {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]つかいかたは /scratch-project プロジェクトID だよ`);
      }
      return;
    }

    // ★★★ ブラックリストコマンド（管理者専用） ★★★
    if (messageBody === '/blacklist') {
      if (!isSenderAdmin) {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]管理者しか実行できないコマンドだよ！`);
        return;
      }
      try {
        const result = await pool.query(
          'SELECT account_id FROM black_list WHERE room_id = $1 ORDER BY account_id ASC',
          [roomId]
        );
        if (result.rows.length === 0) {
          await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]ブラックリストは空だよ`);
          return;
        }
        const freshMembers = await ChatworkBotUtils.getChatworkMembers(roomId);
        let listText = '';
        for (const row of result.rows) {
          const member = freshMembers.find(m => String(m.account_id) === String(row.account_id));
          const name = member ? member.name : `ID:${row.account_id}`;
          listText += `・${name} (${row.account_id})\n`;
        }
        await ChatworkBotUtils.sendChatworkMessage(roomId,
          `[rp aid=${accountId} to=${roomId}-${messageId}][info][title]ブラックリスト[/title]\n${listText}[/info]`);
      } catch (error) {
        console.error('ブラックリスト取得エラー:', error.message);
      }
      return;
    }

    if (messageBody.startsWith('/blacklist-add ')) {
      if (!isSenderAdmin) {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]管理者しか実行できないコマンドだよ！`);
        return;
      }
      const targetId = messageBody.substring('/blacklist-add '.length).trim();
      if (!targetId) {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]つかいかたは /blacklist-add {ユーザーID} だよ`);
        return;
      }
      await ChatworkBotUtils.addToBlackList(roomId, targetId);
      await ChatworkBotUtils.sendChatworkMessage(roomId,
        `[rp aid=${accountId} to=${roomId}-${messageId}][pname:${targetId}]をブラックリストに追加したよ`);
      return;
    }

    if (messageBody.startsWith('/blacklist-del ')) {
      if (!isSenderAdmin) {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]管理者しか実行できないコマンドだよ！`);
        return;
      }
      const targetId = messageBody.substring('/blacklist-del '.length).trim();
      if (!targetId) {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]つかいかたは /blacklist-del {ユーザーID} だよ`);
        return;
      }
      try {
        await pool.query('DELETE FROM black_list WHERE room_id = $1 AND account_id = $2', [roomId, targetId]);
        await ChatworkBotUtils.sendChatworkMessage(roomId,
          `[rp aid=${accountId} to=${roomId}-${messageId}][pname:${targetId}]をブラックリストから削除したよ`);
      } catch (error) {
        console.error('ブラックリスト削除エラー:', error.message);
      }
      return;
    }

    if (messageBody === '/today') {
      const now = new Date();
      const jstDate = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
      const todayFormatted = jstDate.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
      let messageContent = `[info][title]今日の情報だよ[/title]今日は${todayFormatted}だよっ！`;
      const events = await getTodaysEventsFromJson();
      if (events.length > 0) {
        events.forEach(event => {
          messageContent += `\n今日は${event}だよっ！`;
        });
      } else {
        messageContent += `\n今日は特に登録されたイベントはないみたい。`;
      }
      messageContent += `[/info]`;
      const replyMessage = `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\n\n${messageContent}`;
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
        const names = currentMembers
          .slice().sort((a, b) => a.account_id - b.account_id)
          .map(m => m.name).join('\n');
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

        const infoMessage = `[info][title]この部屋の情報だよ[/title]部屋名：${roomName}\nメンバー数：${memberCount}人\n管理者数：${adminCount}人\nルームID：${roomId}\nファイル数：${fileCount}\nメッセージ数：${messageCount}\n最新メッセージ：[修正中]\nアイコン：${iconLink}\n管理者一覧：${adminList}[/info]`;

        await ChatworkBotUtils.sendChatworkMessage(roomId, infoMessage);
      } catch (error) {
        console.error('ルーム情報取得エラー:', error.message);
        await ChatworkBotUtils.sendChatworkMessage(roomId, 'ルーム情報の取得中にエラーが発生しちゃった。');
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

        let rankingMessage = '[info][title]メッセージ数ランキングだよ[/title]\n';
        if (ranking.length === 0) {
          rankingMessage += '今日のメッセージはまだないみたい\n';
        } else {
          ranking.forEach((item, index) => {
            rankingMessage += `${item.rank}位：[piconname:${item.accountId}] ${item.count}コメ`;
            if (index < ranking.length - 1) {
              rankingMessage += '\n[hr]';
            }
            rankingMessage += '\n';
          });
        }
        rankingMessage += `\n合計：${totalCount}コメ\n(ぼく込みで)[/info]`;

        await ChatworkBotUtils.sendChatworkMessage(roomId, rankingMessage);
      } catch (error) {
        console.error('ランキング取得エラー:', error.message);
        await ChatworkBotUtils.sendChatworkMessage(roomId, 'ランキングの取得中にエラーが発生しました。');
      }
    }

    if (messageBody === '/komekasegi') {
      const messages = [
        'コメ稼ぎだよっ！', '過疎だね…', '静かすぎて風の音が聞こえる気がした',
        'みんな寝落ちしちゃった？', 'ここって無人島かな？', '今日も平和だね',
        '誰か生きてるかな', '砂漠のオアシス状態', 'コメントが凍結してる…',
        'しーん……', 'この空気、逆に好き', '時が止まったみたい', '過疎はよくない',
        'え 電波届いてるよね？', 'こっそり独り言タイム！', 'エコー返ってくる気がする',
        '幽霊さん、どこにいますか？'
      ];

      for (let i = 0; i < 10; i++) {
        const randomMessage = messages[Math.floor(Math.random() * messages.length)];
        await ChatworkBotUtils.sendChatworkMessage(roomId, randomMessage);
        if (i < 9) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    // ----------------------------------------
    // /kick {アカウントID} - 管理者専用
    // ----------------------------------------
    if (!isDirectChat && messageBody.startsWith('/kick ') && isSenderAdmin) {
      const targetId = String(messageBody.substring('/kick '.length).trim());
      if (targetId) {
        try {
          const targetMember = currentMembers.find(m => String(m.account_id) === targetId);
          if (!targetMember) {
            await ChatworkBotUtils.sendChatworkMessage(roomId,
              `[rp aid=${accountId} to=${roomId}-${messageId}]そのIDのメンバーはこの部屋にいないみたい`);
            return;
          }

          const admins  = currentMembers.filter(m => m.role === 'admin'    && String(m.account_id) !== targetId).map(m => String(m.account_id));
          const members = currentMembers.filter(m => m.role === 'member'   && String(m.account_id) !== targetId).map(m => String(m.account_id));
          const readonly= currentMembers.filter(m => m.role === 'readonly' && String(m.account_id) !== targetId).map(m => String(m.account_id));

          if (admins.length === 0) {
            await ChatworkBotUtils.sendChatworkMessage(roomId,
              `[rp aid=${accountId} to=${roomId}-${messageId}]管理者が0人になっちゃうからキックできないよ`);
            return;
          }

          const params = new URLSearchParams();
          if (admins.length  > 0) params.append('members_admin_ids',    admins.join(','));
          if (members.length > 0) params.append('members_member_ids',   members.join(','));
          if (readonly.length> 0) params.append('members_readonly_ids', readonly.join(','));

          await apiCallLimiter();
          await axios.put(
            `https://api.chatwork.com/v2/rooms/${roomId}/members`,
            params,
            { headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN } }
          );

          await ChatworkBotUtils.sendChatworkMessage(roomId,
            `[pname:${targetId}]をキックしたよっ！`);
          console.log(`キック完了: ${targetId} from room ${roomId}`);
        } catch (error) {
          console.error('キックエラー:', error.message);
          await ChatworkBotUtils.sendChatworkMessage(roomId,
            `[rp aid=${accountId} to=${roomId}-${messageId}]キックに失敗しちゃった: ${error.message}`);
        }
      }
      return;
    }

    // ----------------------------------------
    // /mute {アカウントID} - 管理者専用
    // ----------------------------------------
    if (!isDirectChat && messageBody.startsWith('/mute ') && isSenderAdmin) {
      const targetId = String(messageBody.substring('/mute '.length).trim());
      if (targetId) {
        try {
          const targetMember = currentMembers.find(m => String(m.account_id) === targetId);
          if (!targetMember) {
            await ChatworkBotUtils.sendChatworkMessage(roomId,
              `[rp aid=${accountId} to=${roomId}-${messageId}]そのIDのメンバーはこの部屋にいないみたい`);
            return;
          }

          if (targetMember.role === 'readonly') {
            await ChatworkBotUtils.sendChatworkMessage(roomId,
              `[rp aid=${accountId} to=${roomId}-${messageId}][pname:${targetId}]はもう閲覧のみだよ`);
            return;
          }

          const admins  = currentMembers.filter(m => m.role === 'admin'    && String(m.account_id) !== targetId).map(m => String(m.account_id));
          const members = currentMembers.filter(m => m.role === 'member'   && String(m.account_id) !== targetId).map(m => String(m.account_id));
          const readonly= currentMembers.filter(m => m.role === 'readonly').map(m => String(m.account_id));
          readonly.push(targetId);

          if (admins.length === 0) {
            await ChatworkBotUtils.sendChatworkMessage(roomId,
              `[rp aid=${accountId} to=${roomId}-${messageId}]管理者が0人になっちゃうからミュートできないよ`);
            return;
          }

          const params = new URLSearchParams();
          if (admins.length  > 0) params.append('members_admin_ids',    admins.join(','));
          if (members.length > 0) params.append('members_member_ids',   members.join(','));
          if (readonly.length> 0) params.append('members_readonly_ids', readonly.join(','));

          await apiCallLimiter();
          await axios.put(
            `https://api.chatwork.com/v2/rooms/${roomId}/members`,
            params,
            { headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN } }
          );

          await ChatworkBotUtils.sendChatworkMessage(roomId,
            `[pname:${targetId}]を閲覧のみにしたよっ！`);
          console.log(`ミュート完了: ${targetId} in room ${roomId}`);
        } catch (error) {
          console.error('ミュートエラー:', error.message);
          await ChatworkBotUtils.sendChatworkMessage(roomId,
            `[rp aid=${accountId} to=${roomId}-${messageId}]ミュートに失敗しちゃった: ${error.message}`);
        }
      }
      return;
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

    // ★★★ 地雷トグルコマンド ★★★

    // /jirai-test コマンド（デバッグ用・管理者専用）
    if (messageBody === '/jirai-test') {
      if (!isSenderAdmin) {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]管理者しか実行できないコマンドだよ！`);
        return;
      }
      const toggles = await loadJiraiToggles();
      const jiraiProb = await ChatworkBotUtils.getJiraiProbability(accountId, isSenderAdmin);
      const testMsg = `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\n地雷テスト\n現在の確率: ${(jiraiProb * 100).toFixed(2)}%\nルームID: ${roomId}\nLOG_ROOM_ID: ${LOG_ROOM_ID}\n一致: ${String(roomId) === LOG_ROOM_ID}\nアカウントID: ${accountId}\n管理者: ${isSenderAdmin}\n\nトグル状態:\ngakusei: ${toggles.gakusei}\nnyanko_a: ${toggles.nyanko_a}\nmilk: ${toggles.milk}\nadmin: ${toggles.admin}\nyuyuyu: ${toggles.yuyuyu}`;
      await ChatworkBotUtils.sendChatworkMessage(roomId, testMsg);
      console.log(`地雷テスト実行: prob=${jiraiProb}, toggles=${JSON.stringify(toggles)}`);
      return;
    }

    // /jirai-force コマンド（強制発動テスト用・管理者専用）
    if (messageBody === '/jirai-force') {
      if (!isSenderAdmin) {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]管理者しか実行できないコマンドだよ！`);
        return;
      }
      // 管理者からランダムに1人選ぶ
      const admins = currentMembers.filter(m => m.role === 'admin');
      const randomAdmin = admins[Math.floor(Math.random() * admins.length)];
      const adminId = randomAdmin.account_id;
      const adminName = randomAdmin.name;

      const jiraiMsg = `[rp aid=${accountId} to=${roomId}-${messageId}]${userName}ちゃん\n地雷ふんじゃったね…\n[To:${adminId}]${adminName}に罰ゲームを考えてもらってね！（強制発動テスト）`;
      await ChatworkBotUtils.sendChatworkMessage(roomId, jiraiMsg);
      console.log(`地雷強制発動: roomId=${roomId}, accountId=${accountId}, 選ばれた管理者=${adminName}`);
      return;
    }

    // /gakusei トグル
    // ★★★ 地雷トグルコマンド（管理者専用、データベースに保存） ★★★

    // /gakusei トグル（管理者専用）
    if (messageBody === '/gakusei') {
      if (!isSenderAdmin) {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]管理者しか実行できないコマンドだよ！`);
        return;
      }

      const toggles = await loadJiraiToggles();
      const newState = !toggles.gakusei;
      await saveJiraiToggle('gakusei', newState);

      const msg = newState
        ? '学生の確率UPがONになりました。(確率：25%)'
        : '学生の確率UPがOFFになりました。';
      await ChatworkBotUtils.sendChatworkMessage(roomId, msg);
      console.log(`/gakusei トグル: ${newState ? 'ON' : 'OFF'}`);
      return;
    }

    // /nyanko_a トグル（管理者専用）
    if (messageBody === '/nyanko_a') {
      if (!isSenderAdmin) {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]管理者しか実行できないコマンドだよ！`);
        return;
      }

      const toggles = await loadJiraiToggles();
      const newState = !toggles.nyanko_a;
      await saveJiraiToggle('nyanko_a', newState);

      const msg = newState
        ? 'nyanko_aの確率UPがONになりました。(確率：100%)'
        : 'nyanko_aの確率UPがOFFになりました。';
      await ChatworkBotUtils.sendChatworkMessage(roomId, msg);
      console.log(`/nyanko_a トグル: ${newState ? 'ON' : 'OFF'}`);
      return;
    }

    // /milk トグル（管理者専用）
    if (messageBody === '/milk') {
      if (!isSenderAdmin) {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]管理者しか実行できないコマンドだよ！`);
        return;
      }

      const toggles = await loadJiraiToggles();
      const newState = !toggles.milk;
      await saveJiraiToggle('milk', newState);

      const msg = newState
        ? '牛乳の確率UPがONになりました。(確率：50%)'
        : '牛乳の確率UPがOFFになりました。';
      await ChatworkBotUtils.sendChatworkMessage(roomId, msg);
      console.log(`/milk トグル: ${newState ? 'ON' : 'OFF'}`);
      return;
    }

    // /admin トグル（管理者専用）
    if (messageBody === '/admin') {
      if (!isSenderAdmin) {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]管理者しか実行できないコマンドだよ！`);
        return;
      }

      const toggles = await loadJiraiToggles();
      const newState = !toggles.admin;
      await saveJiraiToggle('admin', newState);

      const msg = newState
        ? '管理者の確率UPがONになりました。(確率：25%)'
        : '管理者の確率UPがOFFになりました。';
      await ChatworkBotUtils.sendChatworkMessage(roomId, msg);
      console.log(`/admin トグル: ${newState ? 'ON' : 'OFF'}`);
      return;
    }

    // /yuyuyu トグル（管理者専用）
    if (messageBody === '/yuyuyu') {
      if (!isSenderAdmin) {
        await ChatworkBotUtils.sendChatworkMessage(roomId, `[rp aid=${accountId} to=${roomId}-${messageId}]管理者しか実行できないコマンドだよ！`);
        return;
      }

      const toggles = await loadJiraiToggles();
      const newState = !toggles.yuyuyu;
      await saveJiraiToggle('yuyuyu', newState);

      const msg = newState
        ? 'ゆゆゆの確率UPがONになりました。(確率：75%)'
        : 'ゆゆゆの確率UPがOFFになりました。';
      await ChatworkBotUtils.sendChatworkMessage(roomId, msg);
      console.log(`/yuyuyu トグル: ${newState ? 'ON' : 'OFF'}`);
      return;
    }

    const responses = {
      'はんせい': `[To:10911090] はんせい\n[pname:${accountId}]に呼ばれてるよっ！`,
      'ゆゆゆ': `[To:10911090] ゆゆゆ\n[pname:${accountId}]に呼ばれてるよっ！`,
      'からめり': `[To:10337719] からめり\n[pname:${accountId}]に呼ばれてるよっ！`,
      '学生':`[To:9553691] がっくせい\n[pname:${accountId}]に呼ばれてるよっ！`,
      'みおん':`はーい！`,
      'いろいろあぷり': `https://shiratama-kotone.github.io/any-app/\nどーぞ！`,
      '喘いでください湊音様': `そう簡単に喘ぐとでも思った？残念！ぼくは喘ぎません...っ♡///`,
      'おやすみ': `おやすみ！`,
      'おはよう': `おはよう！`,
      '/test': `アカウントIDは${accountId}だよっ！`,
      'プロセカやってくる': `がんばれ！`,
      'せっ': `くす`,
      '精': `子`,
      '114': `514`,
      'ちん': `ちんㅤ`,
      '富士山': `3776m!`,
      'TOALL': `[toall...するわけないじゃん！`,
      'botのコードください': `https://github.com/shiratama-kotone/cw-bot\nどーぞ！`,
      '1+1=': `1!`,
      'トイレいってくる': `漏らさないでねっ！`,
      '6': `9`,
      'Git': `hub`,
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
app.use(express.urlencoded({ extended: true }));

// WebHookエンドポイント
app.post('/webhook', async (req, res) => {
  try {
    console.log('WebHook受信:', JSON.stringify(req.body, null, 2));
    const webhookEvent = req.body.webhook_event || req.body;

    if (webhookEvent && webhookEvent.room_id) {
      webhookEvent.webhook_event_type = req.body.webhook_event_type || 'message_created';
      webhookEvent.webhook_event_time = req.body.webhook_event_time;

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

// メッセージ送信エンドポイント（HTMLフォーム + URLパラメータ両対応）
app.get('/msg-post', async (req, res) => {
  if (req.query.roomid && req.query.msg) {
    try {
      const { roomid, msg } = req.query;

      const isMember = await ChatworkBotUtils.isRoomMember(roomid);

      if (!isMember) {
        return res.status(304).json({ 
          status: 'error', 
          message: 'ルームに参加していません' 
        });
      }

      let convertedMsg = msg;
      convertedMsg = convertedMsg.replace(/\[返信\s+aid=(\d+)\s+to=([^\]]+)\]/g, '[rp aid=$1 to=$2]');
      convertedMsg = convertedMsg.replace(/\[引用\s+aid=(\d+)\s+time=(\d+)\]([\s\S]*?)\[\/引用\]/g, '[qt][qtmeta aid=$1 time=$2]$3[/qt]');

      const messageId = await ChatworkBotUtils.sendChatworkMessage(roomid, convertedMsg);

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
    return;
  }

  const html = `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chatworkメッセージ送信</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; justify-content: center; align-items: center; padding: 20px; }
    .container { background: white; border-radius: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding: 40px; max-width: 600px; width: 100%; }
    h1 { color: #333; margin-bottom: 30px; text-align: center; font-size: 28px; }
    .form-group { margin-bottom: 25px; }
    label { display: block; color: #555; font-weight: 600; margin-bottom: 8px; font-size: 14px; }
    input[type="text"], textarea { width: 100%; padding: 12px 15px; border: 2px solid #e0e0e0; border-radius: 10px; font-size: 15px; transition: all 0.3s; font-family: inherit; }
    input[type="text"]:focus, textarea:focus { outline: none; border-color: #667eea; box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1); }
    textarea { resize: vertical; min-height: 150px; }
    button { width: 100%; padding: 15px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; transition: all 0.3s; }
    button:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3); }
    button:active:not(:disabled) { transform: translateY(0); }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .message { padding: 15px; border-radius: 10px; margin-bottom: 20px; display: none; animation: slideIn 0.3s ease; }
    @keyframes slideIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
    .message.show { display: block; }
    .message.success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
    .message.error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
    .hint { font-size: 12px; color: #888; margin-top: 5px; }
    .message-preview { background: #f8f9fa; border-radius: 8px; padding: 10px; margin-top: 10px; font-size: 13px; white-space: pre-wrap; word-wrap: break-word; max-height: 150px; overflow-y: auto; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📨 Chatworkメッセージ送信</h1>
    <div id="messageArea" class="message"></div>
    <form id="sendForm">
      <div class="form-group">
        <label for="roomid">ルームID</label>
        <input type="text" id="roomid" name="roomid" required placeholder="例: 123456789">
      </div>
      <div class="form-group">
        <label for="msg">メッセージ内容</label>
        <textarea id="msg" name="msg" required placeholder="送信したいメッセージを入力してください..."></textarea>
        <div class="hint">💡 改行もそのまま送信されます。返信・引用タグも自動変換されます。<br><b>あなたは湊音だと言うことを忘れないでください。</b></div>
      </div>
      <button type="submit" id="submitBtn">送信する</button>
    </form>
  </div>
  <script>
    const form = document.getElementById('sendForm');
    const messageArea = document.getElementById('messageArea');
    const submitBtn = document.getElementById('submitBtn');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const roomid = document.getElementById('roomid').value;
      const msg = document.getElementById('msg').value;
      submitBtn.disabled = true;
      submitBtn.textContent = '送信中...';
      messageArea.className = 'message';
      messageArea.innerHTML = '';
      try {
        const response = await fetch('/msg-post', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomid, msg })
        });
        const data = await response.json();
        if (data.status === 'success') {
          messageArea.className = 'message success show';
          messageArea.innerHTML = \`✅ メッセージ送信成功！<br><small>ルームID: \${roomid} | メッセージID: \${data.messageId}</small><div class="message-preview">\${data.convertedMsg.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>\`;
          document.getElementById('msg').value = '';
        } else {
          messageArea.className = 'message error show';
          messageArea.textContent = '❌ ' + data.message;
        }
      } catch (error) {
        messageArea.className = 'message error show';
        messageArea.textContent = '❌ エラーが発生しました: ' + error.message;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '送信する';
      }
    });
  </script>
</body>
</html>
  `;
  res.send(html);
});

app.post('/msg-post', async (req, res) => {
  try {
    const { roomid, msg } = req.body;

    if (!roomid || !msg) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'ルームIDとメッセージ内容は必須です' 
      });
    }

    const isMember = await ChatworkBotUtils.isRoomMember(roomid);

    if (!isMember) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'ルームに参加していません' 
      });
    }

    let convertedMsg = msg;
    convertedMsg = convertedMsg.replace(/\[返信\s+aid=(\d+)\s+to=([^\]]+)\]/g, '[rp aid=$1 to=$2]');
    convertedMsg = convertedMsg.replace(/\[引用\s+aid=(\d+)\s+time=(\d+)\]([\s\S]*?)\[\/引用\]/g, '[qt][qtmeta aid=$1 time=$2]$3[/qt]');

    const messageId = await ChatworkBotUtils.sendChatworkMessage(roomid, convertedMsg);

    if (messageId) {
      res.json({ 
        status: 'success', 
        message: 'メッセージを送信しました',
        messageId: messageId,
        convertedMsg: convertedMsg
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
    message: 'ぼくは元気に稼働中！',
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
    const toggles = await loadJiraiToggles();

    res.json({
      status: '元気！',
      mode: '全部のルームをみてるよ！',
      storage: 'PostgreSQL + Memory',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      logRoomId: LOG_ROOM_ID,
      logDestinationRoomId: LOG_DESTINATION_ROOM_ID,
      botAccountId: BOT_ACCOUNT_ID,
      dayJsonUrl: DAY_JSON_URL,
      directChatRooms: DIRECT_CHAT_WITH_DATE_CHANGE,
      jiraiToggles: toggles,
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
        message: '震度は10〜70の範囲で指定してね（10=震度1, 70=震度7）'
      });
    }

    const now = new Date();
    const testEarthquakeInfo = {
      id: `test_${Date.now()}`,
      time: now.toISOString(),
      hypocenter: 'ぼくの夢の中',
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
          let message = `[info][title]日付変更だよ[/title]今日は${todayFormatted}だよっ！`;
          const events = await getTodaysEventsFromJson();
          if (events.length > 0) {
            events.forEach(event => {
              message += `\n今日は${event}だよっ！`;
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
    const message = '11時だよ！ぼくはもう眠くなってきちゃった…';

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

// おはようせかい
async function ohayosekai() {
  try {
    console.log('おはようせかい');
    const message = 'おはようせかい';

    for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
      try {
        await ChatworkBotUtils.sendChatworkMessage(roomId, message);
        console.log(`おはようせかい完了: ルーム ${roomId}`);
      } catch (error) {
        console.error(`ルーム ${roomId} へのおはようせかいエラー:`, error.message);
      }
    }
  } catch (error) {
    console.error('おはようせかいエラー:', error.message);
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

        let rankingMessage = '今日のコメ数ランキングだよっ！\n[info][title]コメ数ランキング！[/title]\n';
        if (ranking.length === 0) {
          rankingMessage += '今日のメッセージはまだないみたい。\n';
        } else {
          ranking.forEach((item, index) => {
            rankingMessage += `${item.rank}位：[piconname:${item.accountId}] ${item.count}コメ`;
            if (index < ranking.length - 1) {
              rankingMessage += '\n[hr]';
            }
            rankingMessage += '\n';
          });
        }
        rankingMessage += `\n合計：${totalCount}コメ\n(ぼく込み)[/info]`;

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

        let rankingMessage = '[info][title]日付変更の前のランキング[/title]\n';
        if (ranking.length === 0) {
          rankingMessage += '今日のメッセージはまだないみたい。\n';
        } else {
          ranking.forEach((item, index) => {
            rankingMessage += `${item.rank}位：[piconname:${item.accountId}] ${item.count}コメ`;
            if (index < ranking.length - 1) rankingMessage += '\n[hr]';
            rankingMessage += '\n';
          });
        }
        rankingMessage += `\n合計：${totalCount}コメ\n(ぼく込み)[/info]`;

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

// 朝6時の通知と今日の天気予報
async function sendMorningMessage() {
  try {
    console.log('朝6時の通知を送信します');
    const message = 'みんなおはよう！\nぼくはまだ眠いなぁ';

    for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
      try {
        await ChatworkBotUtils.sendChatworkMessage(roomId, message);
        console.log(`朝6時通知送信完了: ルーム ${roomId}`);
      } catch (error) {
        console.error(`ルーム ${roomId} への朝6時通知送信エラー:`, error.message);
      }
    }

    await sendTodayWeather();
  } catch (error) {
    console.error('朝6時通知処理エラー:', error.message);
  }
}

// 今日の天気予報送信（朝6時）
async function sendTodayWeather() {
  try {
    console.log('今日の天気予報を送信します');

    for (const area of WEATHER_AREAS) {
      const weatherData = await ChatworkBotUtils.getWeatherForecast(area.code);

      if (!weatherData || !weatherData.forecasts || weatherData.forecasts.length === 0) {
        console.error(`天気予報取得失敗: ${area.name}`);
        continue;
      }

      const today = weatherData.forecasts[0];
      const telop = today.telop || '不明';
      const maxTemp = today.temperature.max ? `${today.temperature.max.celsius}℃` : '不明';
      const minTemp = today.temperature.min && today.temperature.min.celsius ? `${today.temperature.min.celsius}℃` : null;

      let message = `[info][title]たぶん${area.name}の今日の天気予報[/title]天気は${telop}だよ\n最高気温は${maxTemp}だよ`;
      if (minTemp) {
        message += `\n最低気温はたぶん${minTemp}だよ`;
      }
      message += `\n天気概況文はいらない！\nぼくの判断。[/info]`;

      for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
        try {
          await ChatworkBotUtils.sendChatworkMessage(roomId, message);
          console.log(`今日の天気予報送信完了: ${area.name} -> ルーム ${roomId}`);
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error(`ルーム ${roomId} への天気予報送信エラー:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('今日の天気予報送信処理エラー:', error.message);
  }
}

// 明日の天気予報送信（午後6時）
async function sendTomorrowWeather() {
  try {
    console.log('明日の天気予報を送信します');

    for (const area of WEATHER_AREAS) {
      const weatherData = await ChatworkBotUtils.getWeatherForecast(area.code);

      if (!weatherData || !weatherData.forecasts || weatherData.forecasts.length < 2) {
        console.error(`天気予報取得失敗: ${area.name}`);
        continue;
      }

      const tomorrow = weatherData.forecasts[1];
      const telop = tomorrow.telop || '不明';
      const maxTemp = tomorrow.temperature.max ? `${tomorrow.temperature.max.celsius}℃` : '不明';
      const minTemp = tomorrow.temperature.min && tomorrow.temperature.min.celsius ? `${tomorrow.temperature.min.celsius}℃` : null;

      let message = `[info][title]たぶん${area.name}の明日の天気予報[/title]天気は${telop}だよ\n最高気温は${maxTemp}だよ`;
      if (minTemp) {
        message += `\n最低気温はたぶん${minTemp}だよ`;
      }
      message += `\n天気概況文はいらない！\nぼくの判断。[/info]`;

      for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
        try {
          await ChatworkBotUtils.sendChatworkMessage(roomId, message);
          console.log(`明日の天気予報送信完了: ${area.name} -> ルーム ${roomId}`);
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error(`ルーム ${roomId} への天気予報送信エラー:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('明日の天気予報送信処理エラー:', error.message);
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

// 3/11 14:45 東日本大震災追悼メッセージ
async function send311Memorial() {
  try {
    console.log('3/11 追悼メッセージを送信します');

    const now = new Date();
    const jstDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const currentYear = jstDate.getFullYear();
    const yearsSince = currentYear - 2011;

    const message = `今日は3月11日。東日本大震災から${yearsSince}年が経ちました。
2011年3月11日14時46分、日本は観測史上最大級の地震と大津波に見舞われ、多くの尊い命が失われました。
今もなお、あの日の記憶や想いを胸に生きている方々がいます。

普段の何気ない日常が、決して当たり前ではないことを改めて考える日でもあります。
震災で亡くなられた方々、そして被災されたすべての方々に心を寄せたいと思います。

まもなく14時46分です。
犠牲になられた方々へ、黙祷を捧げましょう。`;

    for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
      try {
        await ChatworkBotUtils.sendChatworkMessage(roomId, message);
        console.log(`3/11追悼メッセージ送信完了: ルーム ${roomId}`);
      } catch (error) {
        console.error(`ルーム ${roomId} への3/11追悼メッセージ送信エラー:`, error.message);
      }
    }
  } catch (error) {
    console.error('3/11追悼メッセージ送信処理エラー:', error.message);
  }
}

// 3/11 14:46 黙祷メッセージ
async function send311Silence() {
  try {
    console.log('3/11 黙祷メッセージを送信します');
    const message = '黙祷';

    for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
      try {
        await ChatworkBotUtils.sendChatworkMessage(roomId, message);
        console.log(`3/11黙祷メッセージ送信完了: ルーム ${roomId}`);
      } catch (error) {
        console.error(`ルーム ${roomId} への3/11黙祷メッセージ送信エラー:`, error.message);
      }
    }
  } catch (error) {
    console.error('3/11黙祷メッセージ送信処理エラー:', error.message);
  }
}

// 2日前のメッセージログを削除（ルーム415060980のみ）
async function cleanupOldMessageLogs() {
  try {
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

    const result = await pool.query(
      'DELETE FROM message_logs WHERE created_at < $1 AND room_id = $2',
      [twoDaysAgo, LOG_ROOM_ID]
    );

    console.log(`古いメッセージログを削除: ${result.rowCount}件`);
  } catch (error) {
    console.error('メッセージログ削除エラー:', error.message);
  }
}

// アラームチェック＆送信
async function checkAndSendAlarms() {
  try {
    const now = new Date();
    const result = await pool.query(
      'SELECT * FROM alarms WHERE scheduled_time <= $1',
      [now]
    );

    for (const alarm of result.rows) {
      await ChatworkBotUtils.sendChatworkMessage(alarm.room_id, alarm.message);
      await pool.query('DELETE FROM alarms WHERE id = $1', [alarm.id]);
      console.log(`アラーム送信完了: ID ${alarm.id}`);
    }
  } catch (error) {
    console.error('アラームチェックエラー:', error.message);
  }
}

// cron: おはようせかい
cron.schedule('0 0 0 * * *', async () => {
  await ohayosekai();
}, { timezone: "Asia/Tokyo" });

// cron: 毎日0時0分に実行
cron.schedule('0 0 0 * * *', async () => {
  await sendDailyGreetingMessages();
}, { timezone: "Asia/Tokyo" });

// cron: 毎日0時5分に古いログ削除
cron.schedule('5 0 0 * * *', async () => {
  await cleanupOldMessageLogs();
}, { timezone: "Asia/Tokyo" });

// cron: 毎日23時0分に実行
cron.schedule('0 0 23 * * *', async () => {
  await sendNightMessage();
}, { timezone: "Asia/Tokyo" });

// cron: 毎日23時55分に実行
cron.schedule('0 55 23 * * *', async () => {
  await sendPreMidnightRanking();
}, { timezone: "Asia/Tokyo" });

// cron: 毎日23時59分に実行
cron.schedule('0 59 23 * * *', async () => {
  await sendDailyRanking();
}, { timezone: "Asia/Tokyo" });

// cron: 毎日6時0分に実行
cron.schedule('0 0 6 * * *', async () => {
  await sendMorningMessage();
}, { timezone: "Asia/Tokyo" });

// cron: 毎日18時0分に実行（明日の天気予報）
cron.schedule('0 0 18 * * *', async () => {
  await sendTomorrowWeather();
}, { timezone: "Asia/Tokyo" });

// cron: 1分ごとに地震情報をチェック
cron.schedule('*/1 * * * *', async () => {
  await checkEarthquakeInfo();
}, { timezone: "Asia/Tokyo" });

// cron: 1分ごとにアラームをチェック
cron.schedule('*/1 * * * *', async () => {
  await checkAndSendAlarms();
}, { timezone: "Asia/Tokyo" });

// cron: 3月11日14:45 東日本大震災追悼メッセージ
cron.schedule('45 14 11 3 *', async () => {
  await send311Memorial();
}, { timezone: "Asia/Tokyo" });

// cron: 3月11日14:46 黙祷
cron.schedule('46 14 11 3 *', async () => {
  await send311Silence();
}, { timezone: "Asia/Tokyo" });

// サーバー起動
app.listen(port, async () => {
  console.log(`みおんがポート${port}で起動しました`);
  console.log('WebHook URL: https://your-app-name.onrender.com/webhook');
  console.log('環境変数:');
  console.log('- CHATWORK_API_TOKEN:', CHATWORK_API_TOKEN ? '設定済みだよ' : '未設定かも');
  console.log('- INFO_API_TOKEN:', INFO_API_TOKEN ? '設定済みだよ' : '未設定かも');
  console.log('- DATABASE_URLは', process.env.DATABASE_URL ? '設定済みだよ' : '未設定かも');
  console.log('- DIRECT_CHAT_WITH_DATE_CHANGEは', DIRECT_CHAT_WITH_DATE_CHANGE);
  console.log('- LOG_ROOM_IDは', LOG_ROOM_ID, '(ウェルカム&地雷の部屋、ログ送信元)');
  console.log('- LOG_DESTINATION_ROOM_IDは', LOG_DESTINATION_ROOM_ID, '(ログ送信先)');
  console.log('- BOT_ACCOUNT_IDは', BOT_ACCOUNT_ID);
  console.log('- DAY_JSON_URLは', DAY_JSON_URL);
  console.log('動作モードはすべてのルームで反応、ログは', LOG_ROOM_ID, 'から', LOG_DESTINATION_ROOM_ID, 'へ送信だよ');

  console.log('\nデータベースを初期化するね...');
  await initializeDatabase();

  console.log('\nメッセージカウントを初期化するね...');
  for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
    await ChatworkBotUtils.initializeMessageCount(roomId);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log('\n累計発言数を初期化するね...');
  for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
    await ChatworkBotUtils.initializeTotalMessageCounts(roomId);
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // ★★★ 地雷トグル状態確認 ★★★
  console.log('\n地雷トグル状態を確認するね...');
  try {
    const toggles = await loadJiraiToggles();
    console.log('地雷トグル状態:', JSON.stringify(toggles, null, 2));
  } catch (error) {
    console.error('地雷トグル読み込みエラー:', error.message);
  }

  // ★★★ 起動通知 ★★★
  console.log('起動通知を送信するね...');
  for (const roomId of DIRECT_CHAT_WITH_DATE_CHANGE) {
    try {
      await ChatworkBotUtils.sendChatworkMessage(roomId, '湊音が起動したよっ！');
      console.log(`起動通知送信完了: ルーム ${roomId}`);
    } catch (error) {
      console.error(`ルーム ${roomId} への起動通知送信エラー:`, error.message);
    }
  }

  console.log('起動かんりょ！\n');
});