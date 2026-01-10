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


// ここから52行目以降が続きます
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

        const infoMessage = `[rp aid=${accountId} to=${roomId}-${messageId}][info][title]${roomName}の情報[/title]部屋名：${roomName}\nメンバー数：${memberCount}人\n管理者数：${adminCount}人\nルームID：${targetRoomId}\nファイル数：${fileCount}\nメッセージ数：${messageCount}\nアイコン：${iconLink}\n管理者一覧：${adminList}[/info]`;
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

        const infoMessage = `[info][title]${roomName}の情報[/title]部屋名：${roomName}\nメンバー数：${memberCount}人\n管理者数：${adminCount}人\nルームID：${roomId}\nファイル数：${fileCount}\nメッセージ数：${messageCount}\n最新メッセージ：${messageLink}\nアイコン：${iconLink}\n管理者一覧：${adminList}[/info]`;

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

    const isMember = await ChatworkBotUtils.isRoomMember(roomid);
    
    if (!isMember) {
      return res.status(304).json({ 
        status: 'error', 
        message: 'ルームに参加していません' 
      });
    }

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

// 朝6時の通知と今日の天気予報
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

    // 今日の天気予報を送信
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
      const description = weatherData.description.text || '情報なし';

      let message = `[info][title]${area.name}の今日の天気予報[/title]天気　　　：${telop}\n最高気温　：${maxTemp}`;
      if (minTemp) {
        message += `\n最低気温　：${minTemp}`;
      }
      message += `\n天気概況文：${description}[/info]`;

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
      const description = weatherData.description.text || '情報なし';

      let message = `[info][title]${area.name}の明日の天気予報[/title]天気　　　：${telop}\n最高気温　：${maxTemp}`;
      if (minTemp) {
        message += `\n最低気温　：${minTemp}`;
      }
      message += `\n天気概況文：${description}[/info]`;

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

// cron: 毎日6時0分に実行
cron.schedule('0 0 6 * * *', async () => {
  await sendMorningMessage();
}, {
  timezone: "Asia/Tokyo"
});

// cron: 毎日18時0分に実行（明日の天気予報）
cron.schedule('0 0 18 * * *', async () => {
  await sendTomorrowWeather();
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
})
