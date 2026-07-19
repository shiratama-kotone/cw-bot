// Chatwork Bot for Render (WebHook版 - 全ルーム対応)
// server.js

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { Pool } = require('pg');
const cheerio = require('cheerio');
let voiceModule = null;
try{ voiceModule = require('@discordjs/voice'); } catch(e){ console.error('[VOICEVOX] @discordjs/voice の読み込みに失敗:', e.message); }
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
const ALLOWED_GUILD_ID                = '1357745161907470336'; // Botの全機能を許可する唯一のサーバーID

const DISCORD_BBS_CHANNEL_ID          = '1512403977029816420';
const DISCORD_WELCOME_CHANNEL_ID      = '1512793318805995670';
const DISCORD_RULES_CHANNEL_ID        = '1369677945513443508';
const DISCORD_INTRO_CHANNEL_ID        = '1357983908691574875';
const DISCORD_LEVEL_UP_CHANNEL_ID     = '1501654246234390598';

const XP_TABLE=[[0,0],[10,100],[50,1000],[100,3000],[200,8000],[300,15000],[400,25000],[500,40000],[600,60000],[700,85000],[800,120000],[900,170000],[1000,250000]];
function totalXpForLevel(lv){if(lv<=0)return 0;for(let i=1;i<XP_TABLE.length;i++){const[l0,x0]=XP_TABLE[i-1],[l1,x1]=XP_TABLE[i];if(lv<=l1)return Math.round(x0+(lv-l0)/(l1-l0)*(x1-x0));}return Math.round(250000+(lv-1000)*800);}
function calcLevel(xp){let lo=0,hi=10000;while(lo<hi){const mid=(lo+hi+1)>>1;totalXpForLevel(mid)<=xp?lo=mid:hi=mid-1;}return lo;}
const LEVEL_ROLES=[{level:10,roleId:'1512803149772226652'},{level:50,roleId:'1512803414042476617'},{level:100,roleId:'1512804446013358090'},{level:200,roleId:'1512804689744498688'},{level:300,roleId:'1512805503271571536'},{level:400,roleId:'1512805730829205675'},{level:500,roleId:'1512805854217371668'},{level:600,roleId:'1512805977924042802'},{level:700,roleId:'1512806132161450024'},{level:800,roleId:'1512806266047561758'},{level:900,roleId:'1512806383899119657'},{level:1000,roleId:'1512806527805952000'}];
function getRoleForLevel(lv){let r=null;for(const lr of LEVEL_ROLES){if(lv>=lr.level)r=lr;}return r;}
function baseXpForLevel(lv){if(lv>=1000)return 5;if(lv>=500)return 3;if(lv>=100)return 2;return 1;}
async function addDiscordXp(member,guildId){
  if(!member||member.user.bot||!dbAvailable)return;
  const userId=member.user.id;
  const cur=await dbQuery('SELECT xp,level FROM discord_levels WHERE guild_id=$1 AND user_id=$2',[guildId,userId]);
  const curLev=cur.rows.length?parseInt(cur.rows[0].level):0;
  const fv=await dbQuery('SELECT ends_at FROM fever WHERE room_id=$1 AND ends_at>NOW()',[CW_ROOM_ID_FOR_DISCORD]);
  const xpGain=baseXpForLevel(curLev)*(fv.rowCount>0?10:1);
  const res=await dbQuery(`INSERT INTO discord_levels (guild_id,user_id,xp,level) VALUES ($1,$2,$3,0) ON CONFLICT (guild_id,user_id) DO UPDATE SET xp=discord_levels.xp+$3,updated_at=NOW() RETURNING xp,level`,[guildId,userId,xpGain]);
  if(!res?.rows?.length)return;
  const newXp=parseInt(res.rows[0].xp),oldLev=parseInt(res.rows[0].level),newLev=calcLevel(newXp);
  if(newLev<=oldLev)return;
  await dbQuery('UPDATE discord_levels SET level=$1 WHERE guild_id=$2 AND user_id=$3',[newLev,guildId,userId]);
  const oldRole=getRoleForLevel(oldLev),newRole=getRoleForLevel(newLev);let roleMsg='';
  if(newRole&&oldRole?.roleId!==newRole.roleId){try{if(oldRole)await member.roles.remove(oldRole.roleId).catch(()=>{});const ar=await member.guild.roles.fetch(newRole.roleId).catch(()=>null);if(ar){await member.roles.add(ar).catch(()=>{});roleMsg=`\n${ar.name}が付与されました。`;}}catch(e){console.error('[Level]ロール:',e.message);}}
  try{if(!discordClient)return;const ch=await discordClient.channels.fetch(DISCORD_LEVEL_UP_CHANNEL_ID).catch(()=>null);if(ch)await ch.send({embeds:[{description:`<@${userId}>さんは**レベル${newLev}**になりました！${roleMsg}`,color:newRole?0xf39c12:0x7289da,footer:{text:`XP: ${newXp.toLocaleString()} | 次のLvまで: ${(totalXpForLevel(newLev+1)-newXp).toLocaleString()} XP`}}]});}catch(e){console.error('[Level]通知:',e.message);}
}
function rand(min,max){return Math.floor(Math.random()*(max-min+1))+min;}
function fmt(n){return Number(n).toLocaleString()+'円';}
// ============================================================
// VOICEVOX読み上げシステム
// ============================================================
const VOICEVOX_API_KEY = process.env.VOICEVOX_API_KEY || '';
const VOICEVOX_BASE = 'https://deprecatedapis.tts.quest/v2/voicevox';
let voicevoxSpeakersCache = null;

async function fetchVoicevoxSpeakers() {
  if (voicevoxSpeakersCache) return voicevoxSpeakersCache;
  try {
    // 話者一覧APIはkeyが不要
    const res = await axios.get(`https://deprecatedapis.tts.quest/v2/voicevox/speakers/?key=${encodeURIComponent(VOICEVOX_API_KEY)}`, { timeout: 15000 });
    const map = {};
    for (const sp of res.data) {
      for (const style of sp.styles) {
        if(style.type === 'talk') { // 読み上げタイプのみ
          map[style.id] = { charName: sp.name, styleName: style.name };
        }
      }
    }
    voicevoxSpeakersCache = map;
    console.log(`[VOICEVOX] 話者キャッシュ完了: ${Object.keys(map).length}件`);
    return map;
  } catch (e) { console.error('[VOICEVOX] 話者一覧取得エラー:', e.message); return {}; }
}

const voiceSessions = new Map();

async function getVoiceSettings(guildId, userId) {
  const DEFAULT = { speaker_id: 3, pitch: 0, speed: 1, intonation: 1 };
  try {
    const u = await dbQuery('SELECT * FROM voice_settings WHERE scope=$1 AND target_id=$2', ['user', userId]);
    if (u.rows.length) return { ...DEFAULT, ...u.rows[0] };
    const g = await dbQuery('SELECT * FROM voice_settings WHERE scope=$1 AND target_id=$2', ['guild', guildId]);
    if (g.rows.length) return { ...DEFAULT, ...g.rows[0] };
  } catch {}
  return DEFAULT;
}

async function applyDictionary(guildId, text) {
  try {
    const r = await dbQuery('SELECT word, reading FROM voice_dictionary WHERE guild_id=$1 ORDER BY LENGTH(word) DESC', [guildId]);
    for (const row of r.rows) {
      text = text.split(row.word).join(row.reading);
    }
  } catch {}
  return text;
}

function buildSpeechText(message) {
  let content = message.content || '';
  const hasAttachment = message.attachments && message.attachments.size > 0;
  content = content.replace(/https?:\/\/\S+/g, 'リンク省略');
  let text = content.trim();
  if (hasAttachment) {
    text = text ? `添付ファイル。${text}` : '添付ファイル。';
  }
  if (!text) return null;
  if (text.length > 50) {
    text = text.substring(0, 50) + '以下略';
  }
  return text;
}

function getSpeechUrl(text, settings) {
  const params = new URLSearchParams({
    text,
    speaker: settings.speaker_id,
    pitch: settings.pitch,
    speed: settings.speed,
    intonationScale: settings.intonation,
    key: VOICEVOX_API_KEY,
  });
  return `${VOICEVOX_BASE}/audio/?${params.toString()}`;
}

async function enqueueSpeech(guildId, text, settings) {
  const session = voiceSessions.get(guildId);
  if (!session) return;
  session.queue.push({ text, settings });
  if (session.queue.length === 1) processQueue(guildId);
}

async function processQueue(guildId) {
  const session = voiceSessions.get(guildId);
  if (!session || !session.queue.length) return;
  const { text, settings } = session.queue[0];
  console.log(`[VOICEVOX] 再生開始: "${text}"`);
  try {
    if(!voiceModule) throw new Error('@discordjs/voice未インストール');
    const { createAudioResource, StreamType } = voiceModule;
    const url = getSpeechUrl(text, settings);
    console.log(`[VOICEVOX] リクエストURL（key伏字）: ${url.replace(/key=[^&]+/,'key=***')}`);
    const res = await axios.get(url, { responseType: 'stream', timeout: 20000 });
    console.log(`[VOICEVOX] 音声取得成功 status=${res.status}`);
    const resource = createAudioResource(res.data, { inputType: StreamType.Arbitrary, inlineVolume: false });
    session.player.play(resource);
    console.log(`[VOICEVOX] player.play実行 playerState=${session.player.state.status}`);
  } catch (e) {
    console.error('[VOICEVOX] 再生エラー詳細:', e.response?.status, e.response?.statusText, e.message);
    session.queue.shift();
    processQueue(guildId);
  }
}
function setupPlayerListeners(guildId) {
  const session = voiceSessions.get(guildId);
  if (!session) return;
  if(!voiceModule) return;
  const { AudioPlayerStatus } = voiceModule;
  session.player.on(AudioPlayerStatus.Idle, () => {
    console.log('[VOICEVOX] player状態: Idle（再生終了）');
    const s = voiceSessions.get(guildId);
    if (!s) return;
    s.queue.shift();
    if (s.queue.length) processQueue(guildId);
  });
  session.player.on(AudioPlayerStatus.Playing, () => {
    console.log('[VOICEVOX] player状態: Playing（再生中）');
  });
  session.player.on('error', (e) => {
    console.error('[VOICEVOX] playerエラー:', e.message);
    const s = voiceSessions.get(guildId);
    if (s) { s.queue.shift(); if (s.queue.length) processQueue(guildId); }
  });
  session.connection.on('error', (e) => {
    console.error('[VOICEVOX] connectionエラー:', e.message);
  });
  session.connection.on('stateChange', (oldS, newS) => {
    console.log(`[VOICEVOX] connection状態変化: ${oldS.status} -> ${newS.status}`);
  });
}

const JOBS={
  'コンビニアルバイト':{tier:'初級',cost:0,desc:'安定して少額稼げる',
    work:(_eco)=>{const b=rand(1057,1300);return{earned:b,msg:`🏪 レジ打ちをした。**${b}円**稼いだ！`};}},
  '新聞配達':{tier:'初級',cost:30000,desc:'朝限定ボーナスあり',
    work:(_eco)=>{const b=rand(1200,1600);const h=parseInt(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo',hour:'numeric',hour12:false}));const bo=(h>=5&&h<=8)?rand(100,500):0;return{earned:b+bo,msg:`📰 新聞を配達した。**${b}円**${bo?` + 朝ボーナス**${bo}円**`:''}稼いだ！`};}},
  '清掃員':{tier:'初級',cost:50000,desc:'安定収入',
    work:(_eco)=>{const b=rand(1400,1800);return{earned:b,msg:`🧹 施設を清掃した。**${b}円**稼いだ！`};}},
  'カフェ店員':{tier:'中級',cost:200000,desc:'接客成功で追加報酬。クレームリスクあり',
    work:(_eco)=>{const b=rand(1600,2500);const r=Math.random();let bo=0,extra='';if(r<0.3){bo=rand(500,2000);extra=` + 接客成功ボーナス**${bo}円**`;}else if(r<0.4){bo=-500;extra=` クレーム発生 **500円**損した…`;}return{earned:b+bo,msg:`☕ カフェで接客した。**${b}円**${extra}稼いだ！`};}},
  '工場作業員':{tier:'中級',cost:300000,desc:'安定寄り。生産目標達成ボーナスあり',
    work:(_eco)=>{const b=rand(2000,3000);const bo=Math.random()<0.25?rand(1000,3000):0;return{earned:b+bo,msg:`🏭 工場ラインで作業した。**${b}円**${bo?` + 目標達成**${bo}円**`:''}稼いだ！`};}},
  'プログラマー':{tier:'中級',cost:500000,desc:'収入のブレ大きめ。大型案件で爆発的収入',
    work:(_eco)=>{const r=Math.random();if(r<0.03){const v=rand(20000,100000);return{earned:v,msg:`💻 🚀 大型案件を受注！！**${v}円**の大金！`};}if(r<0.35){const v=rand(3000,8000);return{earned:v,msg:`💻 📦 開発案件をこなした。**${v}円**稼いだ！`};}const b=rand(500,2000);return{earned:b,msg:`💻 🐛 バグを修正した。**${b}円**稼いだ！`};}},
  '配信者':{tier:'中級',cost:700000,desc:'バズると超高収入。炎上・隠しイベントあり',
    work:(eco)=>{
      const videos=parseInt(eco?.video_count||0);
      let hiddenMult=1;
      if(videos>=500)hiddenMult=2;
      else if(videos>=100)hiddenMult=1.5;
      else if(videos>=50)hiddenMult=1.25;
      else if(videos>=10)hiddenMult=1.1;
      const r=Math.random();
      if(videos>=1){
        const hr=Math.random();
        if(hr<0.00005*hiddenMult){const v=rand(500000,5000000);return{earned:v,msg:`📹 🌟 過去の動画がミーム化した！！**${v}円**の超収入！！！`,videoAdd:0};}
        if(hr<0.0002*hiddenMult){const v=rand(50000,500000);return{earned:v,msg:`📹 🎬 切り抜き動画が話題になった！**${v}円**の収入！！`,videoAdd:0};}
        if(hr<0.0005*hiddenMult){const v=rand(10000,100000);return{earned:v,msg:`📹 📈 過去動画がおすすめに掲載された！**${v}円**の収入！`,videoAdd:0};}
      }
      if(r<0.05){const v=rand(10000,50000);return{earned:v,msg:`📹 🔥 動画がバズった！！**${v}円**の収入！`,videoAdd:1};}
      if(r<0.1){const v=rand(5000,20000);return{earned:-v,msg:`📹 💥 炎上した…**${v}円**の損失…`,videoAdd:1};}
      if(r<0.25){const v=rand(3000,8000);return{earned:v,msg:`📹 👀⭐ 動画が視聴されてチャンネル登録もされた！**${v}円**！`,videoAdd:1};}
      if(r<0.45){const v=rand(2000,5000);return{earned:v,msg:`📹 ⭐ チャンネル登録された！**${v}円**！`,videoAdd:1};}
      if(r<0.65){const v=rand(500,2000);return{earned:v,msg:`📹 👀 動画が視聴された。**${v}円**！`,videoAdd:1};}
      return{earned:0,msg:`📹 🎥 動画を投稿した。(動画本数+1)`,videoAdd:1};
    }},
  '投資家':{tier:'上級',cost:1500000,desc:'運要素強め。大成功・暴落あり',
    work:(_eco)=>{const r=Math.random();if(r<0.05){const v=rand(100000,500000);return{earned:v,msg:`🎲 📈 大成功！**${v}円**の利益！`};}if(r<0.15){const v=rand(20000,100000);return{earned:v,msg:`🎲 📈 株が急騰！**${v}円**の利益！`};}if(r<0.35){const v=rand(10000,50000);return{earned:-v,msg:`🎲 📉 暴落…**${v}円**の大損失…`};}if(r<0.5){const v=rand(1000,10000);return{earned:-v,msg:`🎲 📉 下落…**${v}円**の損失…`};}const b=rand(5000,20000);return{earned:b,msg:`🎲 📊 ポートフォリオ順調。**${b}円**の利益！`};}},
  '医者':{tier:'上級',cost:3000000,desc:'超安定高収入。緊急手術成功ボーナスあり',
    work:(_eco)=>{const b=rand(5000,8000);const bo=Math.random()<0.2?rand(5000,20000):0;return{earned:b+bo,msg:`🩺 患者を診察した。**${b}円**${bo?` + 緊急手術成功**${bo}円**`:''}の報酬！`};}},
  '会社社長':{tier:'上級',cost:5000000,desc:'高収入。大成功で爆発的利益、経営失敗で大損失',
    work:(_eco)=>{const r=Math.random();if(r<0.15){const v=rand(20000,200000);return{earned:v,msg:`🏢 📈 事業大成功！**${v}円**の収益！`};}if(r<0.4){const v=rand(10000,100000);return{earned:-v,msg:`🏢 📉 経営失敗…**${v}円**の損失…`};}const b=rand(3000,15000);return{earned:b,msg:`🏢 事業が順調。**${b}円**の収益！`};}},
  'ギャンブラー':{tier:'特殊',cost:1000000,desc:'完全ランダム。ジャックポットで100万円！',
    work:(_eco)=>{const r=Math.random();if(r<0.001){return{earned:1000000,msg:`🎰 👑 ジャックポット！！！**1,000,000円**！！！！！`};}if(r<0.05){const v=rand(20000,50000);return{earned:v,msg:`🎰 😎 大勝ち！**${v}円**！！`};}if(r<0.2){const v=rand(2000,5000);return{earned:v,msg:`🎰 🙂 小勝ち。**${v}円**！`};}if(r<0.5){const v=rand(1000,5000);return{earned:-v,msg:`🎰 😐 小負け。**${v}円**失った…`};}const v=rand(10000,50000);return{earned:-v,msg:`🎰 💀 大敗！**${v}円**失った…`};}},
  'ニート':{tier:'特殊',cost:0,desc:'お金は稼げないけど特殊効果あり（月曜朝6時に生活保護1000円支給）',
    work:(_eco)=>({earned:0,msg:'ゴロゴロしていた。'})},
};
function workLimitForLevel(lv){if(lv>=1000)return 25;if(lv>=500)return 20;if(lv>=100)return 15;if(lv>=50)return 10;if(lv>=10)return 7;return 5;}

// ============================================================
// チャンネル設定ヘルパー
// ============================================================
async function getGuildChannel(guildId, type) {
  const r = await dbQuery('SELECT channel_id FROM guild_channels WHERE guild_id=$1 AND channel_type=$2', [guildId, type]);
  return r.rows[0]?.channel_id || null;
}
async function setGuildChannel(guildId, type, channelId) {
  await dbQuery(`INSERT INTO guild_channels (guild_id,channel_type,channel_id) VALUES ($1,$2,$3)
    ON CONFLICT (guild_id,channel_type) DO UPDATE SET channel_id=$3,updated_at=NOW()`, [guildId, type, channelId]);
}

// ============================================================
// Server Status チャンネル自動更新
// ============================================================
// 総メッセージ数の簡易カウント（全テキストチャンネルのメッセージ数合計は重すぎるので
// DBに別途カウンタを持つ。初期値は0で、NGワード検知時にインクリメントする代わりに
// guild.channels.cache のapproximateMessageCount等がないため、定期更新時に
// 各チャンネルのfetchedMessages件数を計上する代わりに guild.approximateMemberCount を使う）
// ※ 総メッセージ数はDiscord APIでは取得できないため、botが観測したメッセージ数をDBに蓄積する
async function ensureServerStatusChannels(guild) {
  const { PermissionsBitField, ChannelType } = require('discord.js');
  const everyone = guild.roles.everyone;
  const denyAll = [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.Connect];
  const allowView = [PermissionsBitField.Flags.ViewChannel];

  const r = await dbQuery('SELECT * FROM server_status_channels WHERE guild_id=$1', [guild.id]);
  let row = r.rows[0];

  // カテゴリが存在するか確認、なければ作成
  let category = row?.category_id ? guild.channels.cache.get(row.category_id) : null;
  if (!category) {
    category = await guild.channels.create({
      name: 'サーバー概要', type: ChannelType.GuildCategory,
      permissionOverwrites: [{ id: everyone.id, deny: denyAll }],
    });
  }

  const chDefs = [
    { key: 'total_members_ch', label: '総メンバー数：---' },
    { key: 'members_ch',       label: 'メンバー数：---' },
    { key: 'bots_ch',          label: 'bot数：---' },
    { key: 'channels_ch',      label: 'チャンネル数：---' },
    { key: 'roles_ch',         label: 'ロール数：---' },
    { key: 'total_messages_ch',label: '総メッセージ数：---' },
    { key: 'private_ch',       label: 'プライベートCH数：---' },
  ];

  const chIds = {};
  for (const def of chDefs) {
    // 既存チャンネルが生きているか確認
    const existing = row?.[def.key] ? guild.channels.cache.get(row[def.key]) : null;
    if (existing) {
      chIds[def.key] = existing.id;
    } else {
      // なければ作成
      const ch = await guild.channels.create({
        name: def.label, type: ChannelType.GuildVoice, parent: category.id,
        permissionOverwrites: [{ id: everyone.id, deny: denyAll, allow: allowView }],
      });
      chIds[def.key] = ch.id;
    }
  }

  await dbQuery(`INSERT INTO server_status_channels (guild_id,category_id,total_members_ch,members_ch,bots_ch,channels_ch,roles_ch,total_messages_ch,private_ch)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (guild_id) DO UPDATE SET
    category_id=$2,total_members_ch=$3,members_ch=$4,bots_ch=$5,channels_ch=$6,roles_ch=$7,total_messages_ch=$8,private_ch=$9,updated_at=NOW()`,
    [guild.id, category.id, chIds.total_members_ch, chIds.members_ch, chIds.bots_ch, chIds.channels_ch, chIds.roles_ch, chIds.total_messages_ch, chIds.private_ch]);

  return (await dbQuery('SELECT * FROM server_status_channels WHERE guild_id=$1', [guild.id])).rows[0];
}

async function updateServerStatus(guild) {
  try {
    const { PermissionsBitField, ChannelType } = require('discord.js');
    await guild.members.fetch();
    await guild.channels.fetch();
    const row = await dbQuery('SELECT * FROM server_status_channels WHERE guild_id=$1', [guild.id]);
    if (!row.rows.length || !row.rows[0].total_members_ch) return;
    const d = row.rows[0];
    const allMembers = guild.members.cache;
    const bots = allMembers.filter(m => m.user.bot).size;
    const humans = allMembers.size - bots;
    const everyone = guild.roles.everyone;
    // プライベートチャンネル = @everyoneがViewChannelを持っていないチャンネル
    const privateChCount = guild.channels.cache.filter(ch => {
      if(ch.type === ChannelType.GuildCategory) return false;
      const perms = ch.permissionsFor(everyone);
      return perms && !perms.has(PermissionsBitField.Flags.ViewChannel);
    }).size;
    // 総メッセージ数はDBカウンタから取得
    const msgRow = await dbQuery('SELECT count FROM discord_message_counts WHERE guild_id=$1', [guild.id]);
    const totalMessages = msgRow.rows.length ? Number(msgRow.rows[0].count) : 0;

    const map = {
      [d.total_members_ch]: `総メンバー数：${allMembers.size}人`,
      [d.members_ch]:        `メンバー数：${humans}人`,
      [d.bots_ch]:           `bot数：${bots}台`,
      [d.channels_ch]:       `チャンネル数：${guild.channels.cache.size}個`,
      [d.roles_ch]:          `ロール数：${guild.roles.cache.size}個`,
      [d.total_messages_ch]: `総メッセージ数：${totalMessages.toLocaleString()}件`,
    };
    if(d.private_ch) map[d.private_ch] = `プライベートCH数：${privateChCount}個`;

    for (const [chId, name] of Object.entries(map)) {
      if(!chId) continue;
      const ch = guild.channels.cache.get(chId);
      if (ch && ch.name !== name) await ch.setName(name).catch(()=>{});
    }
  } catch(e) { console.error('[ServerStatus] 更新エラー:', e.message); }
}

// ============================================================
// Discord NGワード処理
// ============================================================
async function checkDiscordNgWords(message) {
  if (!message.guild) return;
  // 除外チャンネルチェック
  const excl = await dbQuery('SELECT 1 FROM discord_ng_exclude_channels WHERE guild_id=$1 AND channel_id=$2', [message.guild.id, message.channel.id]);
  if (excl.rowCount > 0) return;

  const ng = await dbQuery('SELECT pattern, is_regex FROM discord_ng_words WHERE guild_id=$1', [message.guild.id]);
  if (!ng.rowCount) return;

  const content = message.content || '';
  let matched = false;
  for (const row of ng.rows) {
    if (row.is_regex) {
      try { if (new RegExp(row.pattern, 'i').test(content)) { matched = true; break; } } catch {}
    } else {
      if (content.includes(row.pattern)) { matched = true; break; }
    }
  }
  if (!matched) return;

  // メッセージ削除
  await message.delete().catch(() => {});

  // 警告カウントをインクリメント
  const res = await dbQuery(`INSERT INTO discord_warnings (guild_id,user_id,count) VALUES ($1,$2,1)
    ON CONFLICT (guild_id,user_id) DO UPDATE SET count=discord_warnings.count+1,updated_at=NOW()
    RETURNING count`, [message.guild.id, message.author.id]);
  const count = res.rows[0]?.count || 1;

  let actionMsg = `NGワードが含まれていたよ！（警告${count}回目）`;
  try {
    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (member) {
      if (count >= 21) {
        await member.ban({ reason: `NGワード違反 ${count}回` });
        actionMsg += '\n21回以上のため**BAN**しました。';
      } else if (count >= 11) {
        await member.timeout(27 * 24 * 60 * 60 * 1000, `NGワード違反 ${count}回`); // 27日（最大28日に近い値）
        actionMsg += '\n11回以上のためタイムアウト（上限）しました。';
      } else if (count >= 6) {
        await member.timeout(24 * 60 * 60 * 1000, `NGワード違反 ${count}回`); // 1日
        actionMsg += '\n6回以上のためタイムアウト（1日）しました。';
      }
    }
  } catch(e) { console.error('[NG] アクションエラー:', e.message); }

  // DMに通知
  message.author.send(`**NGワード警告**\n${actionMsg}`).catch(()=>{});

  // 管理者チャンネルに通知
  const adminChId = await getGuildChannel(message.guild.id, 'admin');
  if(adminChId){
    const adminCh = message.guild.channels.cache.get(adminChId);
    if(adminCh) adminCh.send({embeds:[{
      title:'NGワード検知',
      description:`<@${message.author.id}>（${message.author.tag}）\nチャンネル: <#${message.channel.id}>\n${actionMsg}`,
      color:0xe74c3c,
      footer:{text:new Date().toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}
    }]}).catch(()=>{});
  } else {
    // 管理者チャンネルが未設定なら元のチャンネルに送信
    const warn = await message.channel.send(`<@${message.author.id}> ${actionMsg}`).catch(() => null);
    if (warn) setTimeout(() => warn.delete().catch(() => {}), 8000);
  }
}
async function getEconomy(guildId,userId){
  const r=await dbQuery('SELECT * FROM discord_economy WHERE guild_id=$1 AND user_id=$2',[guildId,userId]);
  if(r.rows.length)return r.rows[0];
  await dbQuery(`INSERT INTO discord_economy (guild_id,user_id,wallet,bank,job,work_count,work_reset_date) VALUES ($1,$2,0,0,'ニート',0,CURRENT_DATE) ON CONFLICT DO NOTHING`,[guildId,userId]);
  return{wallet:0,bank:0,job:'ニート',work_count:0,work_reset_date:null,last_work_at:null};
}


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

    await dbQuery(`CREATE TABLE IF NOT EXISTS discord_levels (id SERIAL PRIMARY KEY,guild_id TEXT NOT NULL,user_id TEXT NOT NULL,xp BIGINT DEFAULT 0,level INT DEFAULT 0,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,UNIQUE(guild_id,user_id))`);
    await dbQuery(`CREATE INDEX IF NOT EXISTS idx_dl ON discord_levels(guild_id,xp DESC)`);
    await dbQuery(`CREATE TABLE IF NOT EXISTS discord_economy (id SERIAL PRIMARY KEY,guild_id TEXT NOT NULL,user_id TEXT NOT NULL,wallet BIGINT DEFAULT 0,bank BIGINT DEFAULT 0,job TEXT DEFAULT 'ニート',work_count INT DEFAULT 0,work_reset_date DATE DEFAULT CURRENT_DATE,last_work_at TIMESTAMP,video_count INT DEFAULT 0,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,UNIQUE(guild_id,user_id))`);
    await dbQuery(`ALTER TABLE discord_economy ADD COLUMN IF NOT EXISTS video_count INT DEFAULT 0`);

    await dbQuery(`CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY, event_date TEXT NOT NULL, content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(event_date, content))`);

    await dbQuery(`CREATE TABLE IF NOT EXISTS voice_settings (
      id SERIAL PRIMARY KEY,
      scope TEXT NOT NULL,
      target_id TEXT NOT NULL,
      speaker_id INT DEFAULT 3,
      pitch DOUBLE PRECISION DEFAULT 0,
      speed DOUBLE PRECISION DEFAULT 1,
      intonation DOUBLE PRECISION DEFAULT 1,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(scope, target_id))`);

    await dbQuery(`CREATE TABLE IF NOT EXISTS voice_dictionary (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      word TEXT NOT NULL,
      reading TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, word))`);

    await dbQuery(`CREATE TABLE IF NOT EXISTS discord_ng_words (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      pattern TEXT NOT NULL,
      is_regex BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, pattern))`);

    await dbQuery(`CREATE TABLE IF NOT EXISTS discord_ng_exclude_channels (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      UNIQUE(guild_id, channel_id))`);

    await dbQuery(`CREATE TABLE IF NOT EXISTS discord_warnings (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      count INT DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, user_id))`);

    await dbQuery(`CREATE TABLE IF NOT EXISTS server_status_channels (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL UNIQUE,
      category_id TEXT,
      total_members_ch TEXT,
      members_ch TEXT,
      bots_ch TEXT,
      channels_ch TEXT,
      roles_ch TEXT,
      total_messages_ch TEXT,
      private_ch TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await dbQuery(`ALTER TABLE server_status_channels ADD COLUMN IF NOT EXISTS private_ch TEXT`);

    await dbQuery(`CREATE TABLE IF NOT EXISTS discord_message_counts (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL UNIQUE,
      count BIGINT DEFAULT 0)`);

    // チャンネル設定テーブル（/eew, /join-notice, /leveling, /chatwork, /bbs, /admin）
    await dbQuery(`CREATE TABLE IF NOT EXISTS guild_channels (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, channel_type))`);

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
async function getTodaysEvents() {
  try {
    const jst = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));
    const key = `${String(jst.getMonth()+1).padStart(2,'0')}-${String(jst.getDate()).padStart(2,'0')}`;
    const r = await dbQuery('SELECT content FROM events WHERE event_date=$1 ORDER BY created_at',[key]);
    return r.rows.map(row=>row.content);
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
        if(!isCwMsgFromDiscord(messageId)){
          const botName = account?.name || BOT_NORMAL_NAME;
          const txt = cwToDiscordText(messageBody);
          if(txt){
            const did = await sendToDiscordEmbed({
              title: botName,
              description: txt.length>4096?txt.substring(0,4093)+'...':txt,
              color: 0x7289da,
              footer: 'Chatwork'
            });
            if(did){
              discordWebhookMsgIds.add(did);
              await dbQuery('INSERT INTO discord_bridge (cw_message_id,discord_message_id,cw_account_id) VALUES ($1,$2,$3)',
                [String(messageId),did,String(accountId)]).catch(()=>{});
            }
          }
        } else {
          cwMsgIdsFromDiscord.delete(String(messageId));
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
        // Discord→CWで送ったメッセージはDiscordに折り返さない（ループ防止）
        if(isCwMsgFromDiscord(messageId)) {
          cwMsgIdsFromDiscord.delete(String(messageId));
        } else {
          const txt=cwToDiscordText(messageBody);
          if(txt){
            const did=await sendToDiscordEmbed({
              title: userName,
              description: txt.length>4096?txt.substring(0,4093)+'...':txt,
              color: 0x5cb85c,
              footer: `Chatwork`
            });
            if(did){
              discordWebhookMsgIds.add(did);
              await dbQuery('INSERT INTO discord_bridge (cw_message_id,discord_message_id,cw_account_id) VALUES ($1,$2,$3)',
                [String(messageId),did,String(accountId)]).catch(()=>{});
            }
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
    const adminOnly = async ()=>{ if(!isSenderAdmin){ await rp('管理者しか実行できないコマンドだよ！'); return false; } return true; };

    if(messageBody==='/miaq ') { await rp('Make it a QuoteはDiscordの /miaq コマンドで使えるよ！'); return; }
    if(messageBody.startsWith('/lyric ')){
      const url=messageBody.substring(7).trim();
      if(url&&(url.includes('utaten.com')||url.includes('uta-net.com')||url.includes('atwiki.jp')))
        await rp(await CW.lyrics(url));
      else await rp('つかいかたは /lyric {utaten.com、uta-net.com、またはatwiki.jpのURL} だよ');
      return;
    }
    if(messageBody.startsWith('/song-typing-info ')){
      const sid=messageBody.substring(18).trim();
      await rp(sid?await getSongTypingInfo(sid):'つかいかたは /song-typing-info {曲ID} だよ'); return;
    }
    if(['削除','delete','/del','けして'].some(k=>messageBody.includes(k))){
      const m=messageBody.match(/\[rp aid=(\d+) to=(\d+)-(\d+)\]/);
      if(m){ const tm=await CW.getMessage(roomId,m[3]); if(tm&&String(tm.account.account_id)===BOT_ACCOUNT_ID) await CW.deleteMessage(roomId,m[3]); }
    }
    if(messageBody.startsWith('/alarm ')){
      const mx=messageBody.substring(7).trim().match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s+(.+)$/);
      if(!mx){ await rp('使い方: /alarm YYYY-MM-DD HH:MM メッセージ内容'); return; }
      const t=new Date(`${mx[1]}T${mx[2]}:00+09:00`);
      await dbQuery('INSERT INTO alarms (room_id,scheduled_time,message,created_by) VALUES ($1,$2,$3,$4)',[roomId,t,mx[3],accountId]);
      await rp(`アラームを設定したよ！\n${t.toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})} に「${mx[3]}」を送信するね`); return;
    }
    if(messageBody==='/message-total'){
      const r=await dbQuery('SELECT account_id,message_count FROM total_message_counts WHERE room_id=$1 ORDER BY message_count DESC',[roomId]);
      if(!r.rows.length){ await rp('この部屋の累計発言数はまだないみたい'); return; }
      let msg='[info][title]累計発言数ランキング[/title]\n';
      for(let i=0;i<r.rows.length;i++){
        const n=await CW.nameById(r.rows[i].account_id,currentMembers,roomId);
        msg+=`${i+1}位：${n} ${r.rows[i].message_count}コメ`;
        if(i<r.rows.length-1) msg+='\n[hr]'; msg+='\n';
      }
      msg+=`\n合計：${r.rows.reduce((s,x)=>s+parseInt(x.message_count),0)}コメ[/info]`;
      await rp(msg); return;
    }
    if(messageBody==='おみくじ'){ await rp(`${userName}ちゃん[info][title]おみくじ[/title]おみくじの結果は…\n\n${CW.drawOmikuji()}\n\nだよっ！[/info]`); }
    // おみくじXX連（大凶99%版）
    {
      const m10=messageBody.match(/^おみくじ(\d+)連$/);
      if(m10){
        const n=Math.min(parseInt(m10[1]),10000);
        if(n>=1){
          const rs=Array.from({length:n},()=>CW.drawOmikuji());
          await rp(`${userName}ちゃん[info][title]おみくじ${n}連[/title]おみくじ${n}連の結果は…\n\n${CW.summarizeOmikuji(rs)}\n\nだよっ！[/info]`);
        }
      }
    }
    if(messageBody==='/normal-omikuji'){ await rp(`${userName}ちゃん[info][title]普通のおみくじ[/title]おみくじの結果は…\n\n${CW.drawNormalOmikuji()}\n\nだよっ！[/info]`); }
    // /normal-omikuji-XX（普通のおみくじXX連）
    {
      const mn=messageBody.match(/^\/normal-omikuji-(\d+)$/);
      if(mn){
        const n=Math.min(parseInt(mn[1]),10000);
        if(n>=1){
          const rs=Array.from({length:n},()=>CW.drawNormalOmikuji());
          await rp(`${userName}ちゃん[info][title]普通のおみくじ${n}連[/title]普通のおみくじ${n}連の結果は…\n\n${CW.summarizeOmikuji(rs)}\n\nだよっ！[/info]`);
        }
      }
    }
    if(messageBody==='/yes-or-no'){ await rp(`${userName}ちゃん\n答えは「${await CW.yesOrNo()}」だよっ！`); }
    if(messageBody.startsWith('/wiki ')){ const t=messageBody.substring(6).trim(); await rp(t?`${userName}ちゃん\nWikipediaの検索結果だよっ！\n\n${await CW.wikipedia(t)}`:'つかいかたは /wiki 検索ワード だよ'); return; }
    if(messageBody.startsWith('/info ')&&INFO_API_TOKEN){
      const tid=messageBody.substring(6).trim();
      if(!(isDirectChat||isSenderAdmin)){ await rp('このコマンドは管理者だけが使えるよ'); return; }
      const ri=await CW.roomInfoWithToken(tid,INFO_API_TOKEN);
      if(ri.error){ await rp(ri.error==='not_found'?'存在しないルームかも。':'ルーム情報持ってくるのに失敗しちゃった。'); return; }
      const ms=await CW.membersWithToken(tid,INFO_API_TOKEN);
      if(!ms.some(m=>String(m.account_id)===YUYUYU_ACCOUNT_ID)){ await rp('ますたーが参加してないかも。'); return; }
      const ip=ri.icon_path||''; const il=ip?(ip.startsWith('http')?ip:`https://appdata.chatwork.com${ip}`):'なし';
      await rp(`${userName}ちゃん\n[info][title]${ri.name}の情報だよっ！[/title]部屋名：${ri.name}\nメンバー数：${ms.length}人\n管理者数：${ms.filter(m=>m.role==='admin').length}人\nルームID：${tid}\nファイル数：${ri.file_num||0}\nメッセージ数：${ri.message_num||0}\nアイコン：${il}\n管理者一覧：${ms.filter(m=>m.role==='admin').map(m=>m.name).join(', ')||'なし'}[/info]`); return;
    }
    if(messageBody.startsWith('/scratch-user ')){ const u=messageBody.substring(14).trim(); await rp(u?`${userName}ちゃん\n${await CW.scratchUser(u)}`:'つかいかたは /scratch-user ユーザー名 だよ'); return; }
    if(messageBody.startsWith('/scratch-project ')){ const id=messageBody.substring(17).trim(); await rp(id?`${userName}ちゃん\n${await CW.scratchProject(id)}`:'つかいかたは /scratch-project プロジェクトID だよ'); return; }
    if(messageBody==='/blacklist'){
      if(!await adminOnly()) return;
      const r=await dbQuery('SELECT account_id FROM black_list WHERE room_id=$1 ORDER BY account_id',[roomId]);
      if(!r.rows.length){ await rp('ブラックリストは空だよ'); return; }
      let t=''; for(const row of r.rows) t+=`・[picon:${row.account_id}]${await CW.nameById(row.account_id,currentMembers,roomId)}\n`;
      await rp(`${userName}ちゃん\n[info][title]ブラックリスト[/title]\n${t}[/info]`); return;
    }
    if(messageBody.startsWith('/blacklist-add ')){
      if(!await adminOnly()) return;
      const ids=messageBody.substring(15).trim().split(/\s+/).filter(Boolean);
      const added=[]; for(const id of ids){ await CW.addBlackList(roomId,id); added.push(`[picon:${id}]${await CW.nameById(id,currentMembers,roomId)}`); }
      await rp(`${added.join('、')}をブラックリストに追加したよ`); return;
    }
    if(messageBody.startsWith('/blacklist-del ')){
      if(!await adminOnly()) return;
      const ids=messageBody.substring(15).trim().split(/\s+/).filter(Boolean);
      const del=[]; for(const id of ids){ await dbQuery('DELETE FROM black_list WHERE room_id=$1 AND account_id=$2',[roomId,id]); del.push(`[picon:${id}]${await CW.nameById(id,currentMembers,roomId)}`); }
      await rp(`${del.join('、')}をブラックリストから削除したよ`); return;
    }
    if(messageBody==='/today'){
      const jst=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));
      let msg=`[info][title]今日の情報だよ[/title]今日は${jst.toLocaleDateString('ja-JP',{year:'numeric',month:'long',day:'numeric'})}だよっ！`;
      const ev=await getTodaysEvents();
      if(ev.length) ev.forEach(e=>{ msg+=`\n今日は${e}だよっ！`; }); else msg+='\n今日は特に登録されたイベントはないみたい。';
      await rp(`${userName}ちゃん\n\n${msg}[/info]`);
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
      await rp(`${userName}ちゃんの現在のポイントは ${r.rowCount>0?r.rows[0].point:0}pt だよ！`); return;
    }
    if(messageBody==='/points-all'){
      const r=await dbQuery('SELECT account_id,point FROM points WHERE room_id=$1 ORDER BY point DESC',[roomId]);
      if(!r.rowCount){ await rp('まだポイントを持ってる人がいないみたい'); return; }
      let msg='[info][title]ポイントランキング[/title]\n';
      for(let i=0;i<r.rows.length;i++){ const n=await CW.nameById(r.rows[i].account_id,currentMembers,roomId); msg+=`${i+1}位：[picon:${r.rows[i].account_id}]${n} ${r.rows[i].point}pt`; if(i<r.rows.length-1) msg+='\n[hr]'; msg+='\n'; }
      await rp(msg+'[/info]'); return;
    }
    if(messageBody.startsWith('/send ')){
      const [tid,pts]=messageBody.substring(6).trim().split(/\s+/); const sp=parseInt(pts);
      if(!tid||isNaN(sp)||sp<=0){ await rp('つかいかたは /send {ユーザーID} {ポイント} だよ'); return; }
      const my=await dbQuery('SELECT point FROM points WHERE room_id=$1 AND account_id=$2',[roomId,accountId]);
      const mp=my.rowCount>0?parseInt(my.rows[0].point):0;
      if(mp<sp){ await rp(`ポイントが足りないよ！今持ってるのは ${mp}pt だよ`); return; }
      await dbQuery(`UPDATE points SET point=point-$1 WHERE room_id=$2 AND account_id=$3`,[sp,roomId,accountId]);
      await dbQuery(`INSERT INTO points (room_id,account_id,point) VALUES ($1,$2,$3) ON CONFLICT (room_id,account_id) DO UPDATE SET point=points.point+$3,updated_at=NOW()`,[roomId,tid,sp]);
      await rp(`[picon:${tid}]${await CW.nameById(tid,currentMembers,roomId)}に ${sp}pt 送ったよ！`); return;
    }
    if(messageBody.startsWith('/point-add ')){
      if(!['10911090','9553691'].includes(String(accountId))){ await rp('このコマンドは使えないよ！'); return; }
      const [tid,pts]=messageBody.substring(11).trim().split(/\s+/); const ap=parseInt(pts);
      if(!tid||isNaN(ap)||ap<=0) return;
      await dbQuery(`INSERT INTO points (room_id,account_id,point) VALUES ($1,$2,$3) ON CONFLICT (room_id,account_id) DO UPDATE SET point=points.point+$3,updated_at=NOW()`,[roomId,tid,ap]);
      await rp(`[picon:${tid}]${await CW.nameById(tid,currentMembers,roomId)}に ${ap}pt 追加したよ！`); return;
    }
    if(messageBody.startsWith('/point-del ')){
      if(!['10911090','9553691'].includes(String(accountId))){ await rp('このコマンドは使えないよ！'); return; }
      const [tid,pts]=messageBody.substring(11).trim().split(/\s+/); const dp=parseInt(pts);
      if(!tid||isNaN(dp)||dp<=0) return;
      await dbQuery(`INSERT INTO points (room_id,account_id,point) VALUES ($1,$2,0) ON CONFLICT (room_id,account_id) DO UPDATE SET point=GREATEST(points.point-$3,0),updated_at=NOW()`,[roomId,tid,dp]);
      await rp(`[picon:${tid}]${await CW.nameById(tid,currentMembers,roomId)}から ${dp}pt 削除したよ！`); return;
    }
    if(messageBody.startsWith('/fever ')){
      if(!await adminOnly()) return;
      const a=messageBody.substring(7).trim(); const mm=a.match(/^(\d+)m$/),hm=a.match(/^(\d+)h$/);
      let s=mm?parseInt(mm[1])*60:hm?parseInt(hm[1])*3600:0;
      if(s<=0||s>10800){ await rp('時間の指定がおかしいよ！5分なら 5m、3時間なら 3h（最大3時間）'); return; }
      const ea=new Date(Date.now()+s*1000);
      await dbQuery(`INSERT INTO fever (room_id,ends_at) VALUES ($1,$2) ON CONFLICT (room_id) DO UPDATE SET ends_at=$2`,[roomId,ea]);
      await rp(`フィーバータイム開始！${ea.toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})} まで獲得ポイント10倍だよっ！`); return;
    }
    if(messageBody.startsWith('/ng ')){
      if(!await adminOnly()) return;
      const w=messageBody.substring(4).trim(); if(!w) return;
      await dbQuery('INSERT INTO ng_words (room_id,word) VALUES ($1,$2) ON CONFLICT DO NOTHING',[roomId,w]);
      await rp(`「${w}」をNGワードに登録したよ！`); return;
    }
    if(messageBody.startsWith('/ok ')){
      if(!await adminOnly()) return;
      const w=messageBody.substring(4).trim(); if(!w) return;
      await dbQuery('DELETE FROM ng_words WHERE room_id=$1 AND word=$2',[roomId,w]);
      await rp(`「${w}」をNGワードから削除したよ！`); return;
    }
    if(messageBody==='/ng-check'){
      if(!await adminOnly()) return;
      const r=await dbQuery('SELECT word FROM ng_words WHERE room_id=$1 ORDER BY created_at',[roomId]);
      if(!r.rowCount){ await rp('NGワードはまだ登録されてないよ'); return; }
      await rp(`[info][title]NGワード一覧[/title]\n${r.rows.map(x=>`・${x.word}`).join('\n')}[/info]`); return;
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
      await rp(`地雷テスト\n現在の確率: ${(p*100).toFixed(2)}%\nルームID: ${roomId}\nLOG_ROOM_ID: ${LOG_ROOM_ID}\n一致: ${String(roomId)===LOG_ROOM_ID}\nアカウントID: ${accountId}\n管理者: ${isSenderAdmin}\n\nトグル:\ngakusei:${t.gakusei} nyanko_a:${t.nyanko_a} milk:${t.milk} admin:${t.admin} yuyuyu:${t.yuyuyu}`); return;
    }
    if(messageBody==='/jirai-force'){
      if(!await adminOnly()) return;
      const admins=currentMembers.filter(m=>m.role==='admin');
      if(admins.length){ const ra=admins[Math.floor(Math.random()*admins.length)]; await rp(`${userName}ちゃん\n地雷ふんじゃったね…\n[To:${ra.account_id}]${ra.name}に罰ゲームを考えてもらってね！（強制発動テスト）`); } return;
    }
    for(const [tn,label,prob] of [['gakusei','学生の確率UP','25%'],['nyanko_a','nyanko_aの確率UP','100%'],['milk','牛乳の確率UP','50%'],['admin','管理者の確率UP','25%'],['yuyuyu','ゆゆゆの確率UP','75%']]){
      if(messageBody===`/${tn}`){
        if(!await adminOnly()) return;
        const t=await loadJiraiToggles(); const ns=!t[tn]; await saveJiraiToggle(tn,ns);
        await CW.send(roomId,ns?`${label}がONになりました。(確率：${prob})`:`${label}がOFFになりました。`); return;
      }
    }
    if(messageBody.startsWith('/event ')){
      const parts=messageBody.substring(7).trim().split(/\s+/);
      const sub=parts[0];
      if(sub==='add'){
        if(!await adminOnly()) return;
        const date=parts[1],content=parts.slice(2).join(' ');
        if(!date||!content||!/^\d{2}-\d{2}$/.test(date)){ await rp('使い方: /event add MM-DD 内容'); return; }
        await dbQuery('INSERT INTO events (event_date,content) VALUES ($1,$2) ON CONFLICT DO NOTHING',[date,content]);
        await rp(`**${date}** に「${content}」を登録したよ！`); return;
      }
      if(sub==='list'){
        const date=parts[1]||(() => { const jst=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'})); return `${String(jst.getMonth()+1).padStart(2,'0')}-${String(jst.getDate()).padStart(2,'0')}`; })();
        const r=await dbQuery('SELECT id,content FROM events WHERE event_date=$1 ORDER BY created_at',[date]);
        if(!r.rows.length){ await rp(`${date} にイベントはないよ`); return; }
        await rp(`[info][title]${date} のイベント[/title]\n${r.rows.map(row=>`ID:${row.id} ${row.content}`).join('\n')}[/info]`); return;
      }
      if(sub==='del'){
        if(!await adminOnly()) return;
        const id=parseInt(parts[1]);
        if(isNaN(id)){ await rp('使い方: /event del {ID}'); return; }
        const r=await dbQuery('DELETE FROM events WHERE id=$1 RETURNING event_date,content',[id]);
        if(!r.rows.length){ await rp(`ID:${id} のイベントは見つからなかったよ`); return; }
        await rp(`「${r.rows[0].content}」（${r.rows[0].event_date}）を削除したよ`); return;
      }
      await rp('使い方: /event add MM-DD 内容 / /event list [MM-DD] / /event del {ID}'); return;
    }
    if(messageBody==='/help'){
      const common='[info][title]コマンド一覧だよっ！[/title]/help - このヘルプを表示\n[hr]/today - 今日の日付とイベント\n[hr]/test - あなたとこの部屋の情報\n[hr]/info - この部屋の情報\n[hr]/member - メンバー一覧\n[hr]/member-name - メンバー名一覧\n[hr]/romera - 今日のメッセージ数ランキング\n[hr]/message-total - 累計発言数ランキング\n[hr]/points - 自分のポイントを確認\n[hr]/points-all - 全員のポイントランキング\n[hr]/send {ID} {pt} - ポイントを送る\n[hr]/yes-or-no - yes/noをランダム回答\n[hr]/wiki 検索ワード - Wikipedia検索\n[hr]/lyric URL - 歌詞を取得\n[hr]/song-typing-info 曲ID - 歌詞タイピング情報\n[hr]/alarm YYYY-MM-DD HH:MM メッセージ - アラーム設定\n[hr]/scratch-user ユーザー名 - Scratchユーザー情報\n[hr]/scratch-project プロジェクトID - Scratch作品情報\n[hr]/komekasegi - 過疎対策コメ連打\n[hr]/disself - 自分の権限を下げる\n[hr]おみくじ / おみくじ10連 / /yes-or-no - 運試し[/info]';
      const admin=isSenderAdmin?'\n[info][title]管理者専用コマンドだよっ！[/title]/info {ルームID} - 別ルームの情報を取得\n[hr]/kick {ID}... - キック\n[hr]/mute {ID}... - 閲覧のみに変更\n[hr]/blacklist - ブラックリスト確認\n[hr]/blacklist-add {ID}... - ブラックリストに追加\n[hr]/blacklist-del {ID}... - ブラックリストから削除\n[hr]/fever {時間} - フィーバータイム（例: 5m, 1h）\n[hr]/ng {言葉} - NGワード登録\n[hr]/ok {言葉} - NGワード削除\n[hr]/ng-check - NGワード一覧\n[hr]/gakusei /nyanko_a /milk /admin /yuyuyu - 地雷確率トグル\n[hr]/jirai-test - 地雷確率デバッグ\n[hr]/jirai-force - 地雷強制発動テスト[/info]':'';
      await rp(`${userName}ちゃん\n${common}${admin}`); return;
    }
    const responses={'はんせい':`[To:10911090] はんせい\n${userName}に呼ばれてるよっ！`,'ゆゆゆ':`[To:10911090] ゆゆゆ\n${userName}に呼ばれてるよっ！`,'からめり':`[To:10337719] からめり\n${userName}に呼ばれてるよっ！`,'学生':`[To:9553691] がっくせい\n${userName}に呼ばれてるよっ！`,'みおん':'はーい！','いろいろあぷり':'https://shiratama-kotone.github.io/any-app/\nどーぞ！','喘いでください湊音様':'そう簡単に喘ぐとでも思った？残念！ぼくは喘ぎません...っ♡///','おやすみ':'おやすみ！','おはよう':'おはよう！','プロセカやってくる':'がんばれ！','せっ':'くす','精':'子','114':'514','ちん':'ちんㅤ','富士山':'3776m!','TOALL':'[toall...するわけないじゃん！','botのコードください':'https://github.com/shiratama-kotone/cw-bot\nどーぞ！','1+1=':'1!','トイレいってくる':'漏らさないでねっ！','6':'9','Git':'hub'};
    if(responses[messageBody]) await CW.send(roomId,responses[messageBody]);
    if(messageBody==='/test'){
      const jst=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));
      const ri=await CW.roomInfo(roomId);
      await rp(`[info][title]あなたの情報だよっ！[/title]ユーザーID：${accountId}\nユーザー名：${userName}\nルームID：${roomId}\nルーム名：${ri?ri.name:'取得失敗'}\nメッセージID：${messageId}\n時間：${jst.toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}[/info]`);
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


app.post('/bbs-webhook',async(req,res)=>{try{const{event_time,name,no,content,channel}=req.body;if(!name||!content){res.status(400).json({error:'Invalid BBS webhook data'});return;}if(discordClient){const ch=await discordClient.channels.fetch(DISCORD_BBS_CHANNEL_ID).catch(()=>null);if(ch){const jst=event_time?new Date(event_time).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):new Date().toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});await ch.send({embeds:[{title:name,description:content,color:0x5cb85c,fields:[no!=null?{name:'No',value:String(no),inline:true}:null,channel?{name:'チャンネル',value:channel,inline:true}:null].filter(Boolean),footer:{text:`BBS | ${jst}`}}]});}}res.status(200).json({status:'success'});}catch(e){console.error('[BBS]エラー:',e.message);res.status(500).json({error:'Internal server error'});}});

app.get('/',(req,res)=>res.json({status:'OK',message:'ぼくは元気に稼働中！',timestamp:new Date().toISOString(),dbAvailable}));

app.get('/status',async(req,res)=>{
  const t=await loadJiraiToggles();
  res.json({status:'元気！',timestamp:new Date().toISOString(),uptime:process.uptime(),dbAvailable,jiraiToggles:t});
});

// GET /msg-post → 送信UI（Chatwork/Discord選択可）
app.get('/msg-post', (req,res) => {
  res.send(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>メッセージ送信</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#1a1a2e;min-height:100vh;display:flex;justify-content:center;align-items:flex-start;padding:30px 20px;}
.card{background:#16213e;border-radius:16px;padding:32px;width:100%;max-width:640px;box-shadow:0 8px 32px rgba(0,0,0,.4);}
h1{color:#e2e8f0;font-size:22px;margin-bottom:24px;text-align:center;}
.tabs{display:flex;gap:8px;margin-bottom:24px;}
.tab{flex:1;padding:10px;border:2px solid #2d3748;border-radius:10px;background:transparent;color:#a0aec0;cursor:pointer;font-size:14px;transition:.2s;}
.tab.active{border-color:#667eea;background:#667eea22;color:#e2e8f0;}
.section{display:none;} .section.active{display:block;}
label{display:block;color:#a0aec0;font-size:13px;margin-bottom:6px;margin-top:16px;}
input,select,textarea{width:100%;padding:10px 14px;background:#0f3460;border:1.5px solid #2d3748;border-radius:8px;color:#e2e8f0;font-size:14px;transition:.2s;}
input:focus,select:focus,textarea:focus{outline:none;border-color:#667eea;}
select option{background:#0f3460;}
textarea{min-height:130px;resize:vertical;font-family:inherit;}
.row{display:flex;gap:10px;}
.row>*{flex:1;}
.emoji-bar{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;max-height:120px;overflow-y:auto;background:#0f3460;border-radius:8px;padding:8px;}
.emoji-btn{background:#1a2744;border:1px solid #2d3748;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:18px;transition:.15s;}
.emoji-btn:hover{background:#2d3748;}
.send-btn{width:100%;margin-top:20px;padding:13px;background:linear-gradient(135deg,#667eea,#764ba2);border:none;border-radius:10px;color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:.2s;}
.send-btn:hover{opacity:.9;transform:translateY(-1px);}
.send-btn:disabled{opacity:.5;cursor:not-allowed;transform:none;}
.msg{padding:12px;border-radius:8px;margin-top:14px;font-size:13px;display:none;}
.msg.ok{background:#1a3a1a;color:#68d391;border:1px solid #2f6a2f;}
.msg.err{background:#3a1a1a;color:#fc8181;border:1px solid #6a2f2f;}
.hint{font-size:11px;color:#718096;margin-top:4px;}
.channel-list{max-height:200px;overflow-y:auto;margin-top:6px;}
.channel-item{padding:8px 12px;border-radius:6px;cursor:pointer;color:#a0aec0;font-size:13px;transition:.15s;}
.channel-item:hover{background:#1e3a6e;color:#e2e8f0;}
.channel-item.selected{background:#667eea33;color:#e2e8f0;}
.badge{font-size:10px;background:#2d3748;padding:2px 6px;border-radius:4px;margin-left:6px;color:#718096;}
</style>
</head>
<body>
<div class="card">
  <h1>メッセージ送信</h1>
  <div class="tabs">
    <button class="tab active" onclick="switchTab('cw')">Chatwork</button>
    <button class="tab" onclick="switchTab('dc')">Discord</button>
  </div>

  <!-- Chatwork -->
  <div id="sec-cw" class="section active">
    <label>ルームID</label>
    <input id="cw-room" type="text" placeholder="例: 415060980">
    <label>メッセージ</label>
    <textarea id="cw-msg" placeholder="送信内容を入力してください"></textarea>
    <p class="hint">Chatworkタグも使えるよ（[info][title]...[/title]...[/info] など）</p>
    <button class="send-btn" onclick="sendCw()">Chatworkに送信</button>
  </div>

  <!-- Discord -->
  <div id="sec-dc" class="section">
    <label>サーバー</label>
    <select id="dc-guild" onchange="onGuildChange()">
      <option value="">-- サーバーを選択 --</option>
    </select>
    <label>またはサーバーIDを直接入力 <span class="badge">入力するとこちらが優先</span></label>
    <input id="dc-guild-manual" type="text" placeholder="サーバーID（例: 1357745161907470336）" oninput="onManualGuildInput()">

    <label>チャンネル</label>
    <select id="dc-channel">
      <option value="">-- チャンネルを選択 --</option>
    </select>

    <label>メッセージ</label>
    <textarea id="dc-msg" placeholder="送信内容を入力してください"></textarea>

    <label>絵文字 <span class="badge">クリックで挿入</span></label>
    <div id="emoji-bar" class="emoji-bar"><span style="color:#4a5568;font-size:12px">サーバーを選択すると絵文字が表示されるよ</span></div>

    <button class="send-btn" onclick="sendDc()">Discordに送信</button>
  </div>

  <div id="msg-box" class="msg"></div>
</div>

<script>
let currentTab = 'cw';
function switchTab(tab){
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',['cw','dc'][i]===tab));
  document.getElementById('sec-cw').classList.toggle('active',tab==='cw');
  document.getElementById('sec-dc').classList.toggle('active',tab==='dc');
}

function showMsg(text, ok){
  const el = document.getElementById('msg-box');
  el.textContent = text;
  el.className = 'msg ' + (ok?'ok':'err');
  el.style.display = 'block';
  setTimeout(()=>el.style.display='none', 5000);
}

// サーバー一覧を取得
async function loadGuilds(){
  const sel = document.getElementById('dc-guild');
  try{
    const r = await fetch('/api/discord/guilds');
    const guilds = await r.json();
    sel.innerHTML = '<option value="">-- サーバーを選択 --</option>';
    guilds.forEach(g=>{
      const o = document.createElement('option');
      o.value = g.id; o.textContent = g.name;
      sel.appendChild(o);
    });
  }catch(e){ sel.innerHTML = '<option value="">サーバー取得失敗</option>'; }
}

async function onGuildChange(){
  document.getElementById('dc-guild-manual').value = ''; // プルダウン選択時は手入力をクリア
  await loadGuildDetails(document.getElementById('dc-guild').value);
}

let manualGuildTimer = null;
function onManualGuildInput(){
  clearTimeout(manualGuildTimer);
  const val = document.getElementById('dc-guild-manual').value.trim();
  manualGuildTimer = setTimeout(()=>{
    if(val){ document.getElementById('dc-guild').value=''; loadGuildDetails(val); }
  }, 500);
}

async function loadGuildDetails(guildId){
  const chSel = document.getElementById('dc-channel');
  const emojiBar = document.getElementById('emoji-bar');
  chSel.innerHTML = '<option value="">読み込み中...</option>';
  emojiBar.innerHTML = '<span style="color:#4a5568;font-size:12px">読み込み中...</span>';
  if(!guildId){ chSel.innerHTML='<option value="">-- チャンネルを選択 --</option>'; emojiBar.innerHTML='<span style="color:#4a5568;font-size:12px">サーバーを選択すると絵文字が表示されるよ</span>'; return; }
  // チャンネル取得
  try{
    const r = await fetch('/api/discord/channels?guild='+guildId);
    const channels = await r.json();
    chSel.innerHTML = '<option value="">-- チャンネルを選択 --</option>';
    channels.forEach(c=>{
      const o = document.createElement('option');
      o.value = c.id; o.textContent = '#'+c.name;
      chSel.appendChild(o);
    });
  }catch(e){ chSel.innerHTML='<option value="">チャンネル取得失敗</option>'; }
  // 絵文字取得
  try{
    const r = await fetch('/api/discord/emojis?guild='+guildId);
    const emojis = await r.json();
    if(!emojis.length){ emojiBar.innerHTML='<span style="color:#4a5568;font-size:12px">絵文字なし</span>'; return; }
    emojiBar.innerHTML = '';
    emojis.forEach(e=>{
      const btn = document.createElement('button');
      btn.className = 'emoji-btn';
      btn.title = e.name;
      if(e.url){ const img=document.createElement('img');img.src=e.url;img.style.width='20px';img.style.height='20px';img.style.verticalAlign='middle';btn.appendChild(img); }
      else btn.textContent = e.char;
      btn.onclick = ()=>{
        const ta = document.getElementById('dc-msg');
        const ins = e.code || e.char;
        const pos = ta.selectionStart;
        ta.value = ta.value.slice(0,pos)+ins+ta.value.slice(ta.selectionEnd);
        ta.selectionStart = ta.selectionEnd = pos+ins.length;
        ta.focus();
      };
      emojiBar.appendChild(btn);
    });
  }catch(e){ emojiBar.innerHTML='<span style="color:#4a5568;font-size:12px">絵文字取得失敗</span>'; }
}

async function sendCw(){
  const roomid = document.getElementById('cw-room').value.trim();
  const msg = document.getElementById('cw-msg').value;
  if(!roomid||!msg){ showMsg('ルームIDとメッセージを入力してね', false); return; }
  const btn = document.querySelector('#sec-cw .send-btn');
  btn.disabled = true; btn.textContent = '送信中...';
  try{
    const r = await fetch('/msg-post', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roomid,msg})});
    const d = await r.json();
    if(d.status==='success') showMsg('Chatworkに送信したよ！(ID:'+d.messageId+')', true);
    else showMsg('エラー: '+d.message, false);
  }catch(e){ showMsg('エラー: '+e.message, false); }
  btn.disabled = false; btn.textContent = 'Chatworkに送信';
}

async function sendDc(){
  const channelId = document.getElementById('dc-channel').value;
  const msg = document.getElementById('dc-msg').value;
  if(!channelId||!msg){ showMsg('チャンネルとメッセージを入力してね', false); return; }
  const btn = document.querySelector('#sec-dc .send-btn');
  btn.disabled = true; btn.textContent = '送信中...';
  try{
    const r = await fetch('/api/discord/send', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channelId,content:msg})});
    const d = await r.json();
    if(d.status==='success') showMsg('Discordに送信したよ！', true);
    else showMsg('エラー: '+d.message, false);
  }catch(e){ showMsg('エラー: '+e.message, false); }
  btn.disabled = false; btn.textContent = 'Discordに送信';
}

loadGuilds();
</script>
</body>
</html>`);
});

// Discord API: サーバー一覧
app.get('/api/discord/guilds', (req,res) => {
  if(!discordClient){ return res.json([]); }
  const guilds = discordClient.guilds.cache.map(g=>({id:g.id, name:g.name}));
  res.json(guilds);
});

// Discord API: チャンネル一覧（テキストチャンネルのみ）
app.get('/api/discord/channels', async(req,res) => {
  const {guild:guildId} = req.query;
  if(!discordClient||!guildId) return res.json([]);
  try{
    const guild = discordClient.guilds.cache.get(guildId) || await discordClient.guilds.fetch(guildId).catch(()=>null);
    if(!guild) return res.json([]);
    await guild.channels.fetch().catch(()=>{});
    const channels = guild.channels.cache
      .filter(c => c.type === 0) // GUILD_TEXT
      .sort((a,b) => a.position - b.position)
      .map(c => ({id:c.id, name:c.name}));
    res.json(channels);
  }catch(e){ res.status(500).json([]); }
});

// Discord API: 絵文字一覧
app.get('/api/discord/emojis', async(req,res) => {
  const {guild:guildId} = req.query;
  if(!discordClient||!guildId) return res.json([]);
  try{
    const guild = discordClient.guilds.cache.get(guildId) || await discordClient.guilds.fetch(guildId).catch(()=>null);
    if(!guild) return res.json([]);
    await guild.emojis.fetch().catch(()=>{});
    const emojis = guild.emojis.cache.map(e=>({
      id: e.id, name: e.name,
      url: e.imageURL({size:32}),
      code: `<${e.animated?'a':''}:${e.name}:${e.id}>`,
      char: ''
    }));
    res.json(emojis);
  }catch(e){ res.status(500).json([]); }
});

// Discord API: メッセージ送信
app.post('/api/discord/send', async(req,res) => {
  const {channelId, content} = req.body;
  if(!channelId||!content) return res.status(400).json({status:'error',message:'channelIdとcontentは必須です'});
  if(!discordClient) return res.status(503).json({status:'error',message:'Discord botが起動していません'});
  try{
    const ch = await discordClient.channels.fetch(channelId).catch(()=>null);
    if(!ch) return res.status(404).json({status:'error',message:'チャンネルが見つかりません'});
    await ch.send(content);
    res.json({status:'success'});
  }catch(e){ res.status(500).json({status:'error',message:e.message}); }
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

cron.schedule('0 0 6 * * 1',async()=>{try{const r=await dbQuery("SELECT guild_id,user_id FROM discord_economy WHERE job='ニート'");for(const row of r.rows){await dbQuery('UPDATE discord_economy SET wallet=wallet+1000,updated_at=NOW() WHERE guild_id=$1 AND user_id=$2',[row.guild_id,row.user_id]);if(discordClient){const ch=await discordClient.channels.fetch(DISCORD_LEVEL_UP_CHANNEL_ID).catch(()=>null);if(ch)await ch.send({embeds:[{description:`<@${row.user_id}> 生活保護が支給されたよ！（1,000円）`,color:0x95a5a6}]}).catch(()=>{});}}}catch(e){console.error('[Economy]生活保護:',e.message);}},{timezone:'Asia/Tokyo'});

// 1分毎: サーバーステータス更新
cron.schedule('* * * * *', async()=>{
  if(!discordClient) return;
  try{
    const rows=(await dbQuery('SELECT guild_id FROM server_status_channels')).rows;
    for(const row of rows){
      const guild=discordClient.guilds.cache.get(row.guild_id)||await discordClient.guilds.fetch(row.guild_id).catch(()=>null);
      if(guild) await updateServerStatus(guild);
    }
  }catch(e){console.error('[ServerStatus] cronエラー:',e.message);}
});

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

// Embedでwebhook送信
// opts: { title, description, color, fields:[{name,value,inline}], footer }
async function sendToDiscordEmbed(opts) {
  if(!DISCORD_WEBHOOK_URL) return null;
  const embed = {
    title: opts.title || null,
    description: opts.description || null,
    color: opts.color ?? 0x7289da,
  };
  if(opts.fields?.length) embed.fields = opts.fields;
  if(opts.footer) embed.footer = { text: opts.footer };
  try{
    const res = await axios.post(DISCORD_WEBHOOK_URL+'?wait=true',
      { embeds: [embed] },
      { headers: { 'Content-Type': 'application/json' } }
    );
    return res.data.id || null;
  } catch(e){ console.error('[Discord] Embed送信エラー:', e.message); return null; }
}

// Discordクライアントからチャンネルにembedを送る
async function sendEmbedToChannel(channel, opts) {
  const embed = {
    title: opts.title || null,
    description: opts.description || null,
    color: opts.color ?? 0x7289da,
  };
  if(opts.fields?.length) embed.fields = opts.fields;
  if(opts.footer) embed.footer = { text: opts.footer };
  return channel.send({ embeds: [embed] });
}

let discordClient = null;
const discordWebhookMsgIds = new Set();
// Discord→CWで送ったCWメッセージIDのキャッシュ（ループ防止、1分TTL）
// Map<cwMessageId, expireAt(ms)>
const cwMsgIdsFromDiscord = new Map();
function addCwMsgFromDiscord(cwId) {
  cwMsgIdsFromDiscord.set(String(cwId), Date.now() + 60000);
  // 期限切れエントリを定期削除
  for(const [k, exp] of cwMsgIdsFromDiscord) {
    if(Date.now() > exp) cwMsgIdsFromDiscord.delete(k);
  }
}
function isCwMsgFromDiscord(cwId) {
  const exp = cwMsgIdsFromDiscord.get(String(cwId));
  if(!exp) return false;
  if(Date.now() > exp) { cwMsgIdsFromDiscord.delete(String(cwId)); return false; }
  return true;
}

if(DISCORD_BOT_TOKEN){
  discordClient = new Client({intents:[
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
  ], partials: [Partials.Channel, Partials.Message]});

  discordClient.once(Events.ClientReady, async(c)=>{
    console.log(`[Discord] bot起動: ${c.user.tag}`);
    // VOICEVOX話者一覧を起動時に1回だけ取得してキャッシュ（レート制限対策）
    fetchVoicevoxSpeakers().then(s=>console.log(`[VOICEVOX] 話者キャッシュ完了: ${Object.keys(s).length}件`)).catch(()=>{});
    const ADMIN_PERM = PermissionFlagsBits.ManageMessages;

    const cmds = [
      // ━━ 誰でも使えるコマンド ━━
      new SlashCommandBuilder().setName('help').setDescription('コマンド一覧を表示するよ'),
      new SlashCommandBuilder().setName('normal omikuji').setDescription('普通のおみくじを引くよっ！（大凶が極端に多くないよ）'),
      new SlashCommandBuilder().setName('normal omikuji n').setDescription('普通のおみくじをN回引くよ（大凶が極端に多くないよ）').addIntegerOption(o=>o.setName('count').setDescription('回数（1〜10000）').setRequired(true).setMinValue(1).setMaxValue(10000)),
      new SlashCommandBuilder().setName('omikuji n').setDescription('おみくじをN回引くよ（大凶99%版）').addIntegerOption(o=>o.setName('count').setDescription('回数（1〜10000）').setRequired(true).setMinValue(1).setMaxValue(10000)),
      new SlashCommandBuilder().setName('yes or no').setDescription('yes/noをランダム回答するよ'),
      new SlashCommandBuilder().setName('wiki').setDescription('Wikipediaを検索するよ').addStringOption(o=>o.setName('word').setDescription('検索ワード').setRequired(true)),
      new SlashCommandBuilder().setName('today').setDescription('今日の日付とイベントを表示するよ'),
      new SlashCommandBuilder().setName('lyric').setDescription('歌詞を取得するよ').addStringOption(o=>o.setName('url').setDescription('utaten.com/uta-net.com/atwiki.jpのURL').setRequired(true)),
      new SlashCommandBuilder().setName('scratch user').setDescription('Scratchユーザー情報を表示するよ').addStringOption(o=>o.setName('username').setDescription('ユーザー名').setRequired(true)),
      new SlashCommandBuilder().setName('scratch project').setDescription('Scratchプロジェクト情報を表示するよ').addStringOption(o=>o.setName('id').setDescription('プロジェクトID').setRequired(true)),
      new SlashCommandBuilder().setName('song typing info').setDescription('歌詞タイピング情報を表示するよ').addStringOption(o=>o.setName('id').setDescription('曲ID').setRequired(true)),
      new SlashCommandBuilder().setName('romera').setDescription('今日のメッセージ数ランキングを表示するよ（CWルーム415060980対象）'),
      new SlashCommandBuilder().setName('message total').setDescription('累計発言数ランキングを表示するよ（CWルーム415060980対象）'),
      new SlashCommandBuilder().setName('alarm').setDescription('このチャンネルにアラームを設定するよ').addStringOption(o=>o.setName('datetime').setDescription('日時（YYYY-MM-DD HH:MM）').setRequired(true)).addStringOption(o=>o.setName('message').setDescription('メッセージ').setRequired(true)),
      new SlashCommandBuilder().setName('miaq').setDescription('メッセージをMake it a Quoteにするよ').addStringOption(o=>o.setName('message id').setDescription('対象のメッセージID').setRequired(true)),
      new SlashCommandBuilder().setName('room info').setDescription('CWルームの情報を表示するよ（要INFO_API_TOKEN）').addStringOption(o=>o.setName('room id').setDescription('CWルームID').setRequired(true)),
      // ━━ 管理者専用コマンド ━━
      new SlashCommandBuilder().setName('clear').setDescription('メッセージを指定数削除するよ').addIntegerOption(o=>o.setName('count').setDescription('削除数（1〜100）').setRequired(true).setMinValue(1).setMaxValue(100)).setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('prohibit').setDescription('このチャンネルで発言禁止にするよ').addStringOption(o=>o.setName('duration').setDescription('時間（例: 5m, 1h、最大3h）').setRequired(true)).setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('release').setDescription('このチャンネルの発言禁止を解除するよ').setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('ban').setDescription('Discordサーバーからbanするよ').addUserOption(o=>o.setName('user').setDescription('対象ユーザー').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('理由（省略可）')).setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('unban').setDescription('Discordサーバーのbanを解除するよ').addStringOption(o=>o.setName('user-id').setDescription('DiscordユーザーID').setRequired(true)).setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('blacklist').setDescription('CWブラックリストを確認するよ').setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('kick').setDescription('Discordサーバーからキックするよ').addUserOption(o=>o.setName('user').setDescription('対象ユーザー').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('理由（省略可）')).setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('mute').setDescription('DiscordユーザーをタイムアウトするよDefault30分').addUserOption(o=>o.setName('user').setDescription('対象ユーザー').setRequired(true)).addIntegerOption(o=>o.setName('minutes').setDescription('タイムアウト時間（分、デフォルト30）').setMinValue(1).setMaxValue(40320)).setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('fever').setDescription('CWルームのフィーバータイムを開始するよ').addStringOption(o=>o.setName('duration').setDescription('時間（例: 5m, 1h、最大3h）').setRequired(true)).setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('ng add').setDescription('CWルームにNGワードを登録するよ').addStringOption(o=>o.setName('word').setDescription('NGワード').setRequired(true)).setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('ng del').setDescription('CWルームのNGワードを削除するよ').addStringOption(o=>o.setName('word').setDescription('削除するNGワード').setRequired(true)).setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('ng check').setDescription('CWルームのNGワード一覧を表示するよ').setDefaultMemberPermissions(ADMIN_PERM),
      // チャンネル設定コマンド
      new SlashCommandBuilder().setName('eew').setDescription('このチャンネルを地震情報チャンネルに設定するよ').setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('join notice').setDescription('このチャンネルを入室通知チャンネルに設定するよ').setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('leveling').setDescription('このチャンネルをレベルアップ通知チャンネルに設定するよ').setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('chatwork').setDescription('このチャンネルをChatwork連携チャンネルに設定するよ').setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('bbs').setDescription('このチャンネルを掲示板連携チャンネルに設定するよ').setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('admin').setDescription('このチャンネルを管理者チャンネルに設定するよ').setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('log').setDescription('このチャンネルでログを受け取るように設定するよ').setDefaultMemberPermissions(ADMIN_PERM),
      // Discord NGワード（サーバーごと）
      new SlashCommandBuilder().setName('discord ng add').setDescription('DiscordのNGワードを追加するよ')
        .addStringOption(o=>o.setName('pattern').setDescription('NG文字列または正規表現').setRequired(true))
        .addBooleanOption(o=>o.setName('is regex').setDescription('正規表現として扱う（デフォルト:false）'))
        .setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('discord ng list').setDescription('DiscordのNGワード一覧を表示するよ').setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('discord ng remove').setDescription('DiscordのNGワードを削除するよ')
        .addIntegerOption(o=>o.setName('id').setDescription('NGワードのID（一覧で確認）').setRequired(true))
        .setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('discord ng exclude').setDescription('NGワードチェックをこのチャンネルで除外・解除するよ').setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('discord warning reset').setDescription('ユーザーの警告回数をリセットするよ')
        .addUserOption(o=>o.setName('user').setDescription('対象ユーザー').setRequired(true))
        .setDefaultMemberPermissions(ADMIN_PERM),
      // サーバーステータス
      new SlashCommandBuilder().setName('server status').setDescription('サーバー概要カテゴリを作成して1分毎に更新するよ').setDefaultMemberPermissions(ADMIN_PERM),
      new SlashCommandBuilder().setName('event').setDescription('イベントを登録・一覧・削除するよ')
        .addSubcommand(s=>s.setName('add').setDescription('イベントを登録するよ').addStringOption(o=>o.setName('date').setDescription('日付（MM-DD形式、例: 06-15）').setRequired(true)).addStringOption(o=>o.setName('content').setDescription('イベント内容').setRequired(true)))
        .addSubcommand(s=>s.setName('list').setDescription('指定日のイベント一覧を表示するよ').addStringOption(o=>o.setName('date').setDescription('日付（MM-DD形式、省略で今日）')))
        .addSubcommand(s=>s.setName('delete').setDescription('イベントを削除するよ').addIntegerOption(o=>o.setName('id').setDescription('イベントID').setRequired(true)))
        .setDefaultMemberPermissions(ADMIN_PERM),
      // VOICEVOX読み上げ
      new SlashCommandBuilder().setName('join').setDescription('あなたがいるボイスチャンネルに参加して読み上げを開始するよ'),
      new SlashCommandBuilder().setName('leave').setDescription('ボイスチャンネルから退出するよ'),
      new SlashCommandBuilder().setName('dictionary add').setDescription('読み上げ辞書に単語を追加するよ').addStringOption(o=>o.setName('word').setDescription('単語').setRequired(true)).addStringOption(o=>o.setName('reading').setDescription('読み方').setRequired(true)),
      new SlashCommandBuilder().setName('dictionary list').setDescription('読み上げ辞書一覧を表示するよ').addIntegerOption(o=>o.setName('page').setDescription('ページ番号（1から）')),
      new SlashCommandBuilder().setName('dictionary remove').setDescription('読み上げ辞書から単語を削除するよ').addStringOption(o=>o.setName('keyword').setDescription('単語または読みの一部').setRequired(true).setAutocomplete(true)),
      new SlashCommandBuilder().setName('pitch').setDescription('読み上げのピッチを変更するよ（-0.15~0.15）').addNumberOption(o=>o.setName('value').setDescription('ピッチ').setRequired(true).setMinValue(-0.15).setMaxValue(0.15)),
      new SlashCommandBuilder().setName('speed').setDescription('読み上げの話速を変更するよ（0.5~2）').addNumberOption(o=>o.setName('value').setDescription('話速').setRequired(true).setMinValue(0.5).setMaxValue(2)),
      new SlashCommandBuilder().setName('intonation').setDescription('読み上げのイントネーションを変更するよ（0~2）').addNumberOption(o=>o.setName('value').setDescription('イントネーション').setRequired(true).setMinValue(0).setMaxValue(2)),
      new SlashCommandBuilder().setName('speaker').setDescription('読み上げの話者を変更するよ').addIntegerOption(o=>o.setName('id').setDescription('話者ID（/speaker_listで確認）').setRequired(true)),
      new SlashCommandBuilder().setName('speaker list').setDescription('話者一覧を表示するよ（ページ制）').addIntegerOption(o=>o.setName('page').setDescription('ページ番号（1から）')),
      new SlashCommandBuilder().setName('rank').setDescription('自分のレベルとXPを確認するよ'),
      new SlashCommandBuilder().setName('work').setDescription('働いてお金を稼ぐよ（クールダウン30分）'),
      new SlashCommandBuilder().setName('job').setDescription('職一覧を見る'),
      new SlashCommandBuilder().setName('job set').setDescription('職につく・転職する').addStringOption(o=>o.setName('job').setDescription('職名').setRequired(true)),
      new SlashCommandBuilder().setName('job info').setDescription('職の詳細を見る').addStringOption(o=>o.setName('job').setDescription('職名').setRequired(true)),
      new SlashCommandBuilder().setName('money').setDescription('所持金を見る'),
      new SlashCommandBuilder().setName('money send').setDescription('お金を送る').addUserOption(o=>o.setName('user').setDescription('送り先').setRequired(true)).addIntegerOption(o=>o.setName('amount').setDescription('金額').setRequired(true).setMinValue(1)),
      new SlashCommandBuilder().setName('bank').setDescription('銀行残高を見る'),
      new SlashCommandBuilder().setName('bank deposit').setDescription('銀行に預ける').addIntegerOption(o=>o.setName('amount').setDescription('金額').setRequired(true).setMinValue(1)),
      new SlashCommandBuilder().setName('bank withdraw').setDescription('銀行から引き出す').addIntegerOption(o=>o.setName('amount').setDescription('金額').setRequired(true).setMinValue(1)),
      (()=>{const cmd=new SlashCommandBuilder().setName('role panel').setDescription('ロールパネルを作成するよ（最大24ロール）').addStringOption(o=>o.setName('title').setDescription('タイトル').setRequired(true));for(let i=1;i<=24;i++)cmd.addRoleOption(o=>o.setName(`role${i}`).setDescription(`ロール${i}`).setRequired(i===1));return cmd.setDefaultMemberPermissions(ADMIN_PERM);})(),
      new SlashCommandBuilder().setName('verify').setDescription('認証パネルを作成するよ').addRoleOption(o=>o.setName('role').setDescription('認証時に付与するロール').setRequired(true)).addStringOption(o=>o.setName('title').setDescription('タイトル（省略可）')).addStringOption(o=>o.setName('description').setDescription('説明文（省略可）')).setDefaultMemberPermissions(ADMIN_PERM),
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

    // embed返信ヘルパー
    const reply = (desc, opts={}) => interaction.editReply({
      embeds:[{
        title: opts.title||null,
        description: String(desc).substring(0,4096),
        color: opts.color??0x7289da,
        fields: opts.fields||[],
        footer: opts.footer?{text:opts.footer}:undefined
      }],
      content: ''
    });
    const replyErr = (desc) => reply(desc, {color:0xe74c3c, title:'エラー'});

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
        await reply(lines.join('\n'), {title:'コマンド一覧'}); return;
      }

      // ── おみくじ系スラッシュコマンド ──
      if(cmd==='normal_omikuji'){ await reply(`普通のおみくじの結果は…\n**${CW.drawNormalOmikuji()}**\nだよっ！`, {title:'普通のおみくじ'}); return; }
      if(cmd==='normal_omikuji_n'){
        const n=Math.min(interaction.options.getInteger('count'),10000);
        const rs=Array.from({length:n},()=>CW.drawNormalOmikuji());
        await reply(`普通のおみくじ${n}連の結果は…\n**${CW.summarizeOmikuji(rs)}**\nだよっ！`, {title:`普通のおみくじ${n}連`}); return;
      }
      if(cmd==='omikuji_n'){
        const n=Math.min(interaction.options.getInteger('count'),10000);
        const rs=Array.from({length:n},()=>CW.drawOmikuji());
        await reply(`おみくじ${n}連の結果は…\n**${CW.summarizeOmikuji(rs)}**\nだよっ！`, {title:`おみくじ${n}連（大凶99%版）`}); return;
      }
      if(cmd==='yes_or_no'){ await reply(`答えは「**${await CW.yesOrNo()}**」だよっ！`, {title:'yes or no'}); return; }

      // ── wiki ──
      if(cmd==='wiki'){ await reply(await CW.wikipedia(interaction.options.getString('word')), {title:'Wikipedia'}); return; }

      // ── today ──
      if(cmd==='today'){
        const jst=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));
        const ev=await getTodaysEvents();
        let msg=`今日は**${jst.toLocaleDateString('ja-JP',{year:'numeric',month:'long',day:'numeric'})}**だよっ！`;
        if(ev.length) ev.forEach(e=>{msg+=`\n今日は${e}だよっ！`;}); await reply(msg, {title:'今日の情報'}); return;
      }

      // ── lyric ──
      if(cmd==='lyric'){
        const url=interaction.options.getString('url');
        if(!(url.includes('utaten.com')||url.includes('uta-net.com')||url.includes('atwiki.jp'))){ await replyErr('対応URLはutaten.com、uta-net.com、atwiki.jpだよ！'); return; }
        const lyr=await CW.lyrics(url);
        // Chatworkタグを除去してDiscord用に変換
        const disc=lyr.replace(/\[info\]\[title\]([^\[]*)\[\/title\]/g,'**$1**\n').replace(/\[\/info\]/g,'').replace(/\[.*?\]/g,'');
        await reply(disc, {title:'歌詞'}); return;
      }

      // ── scratch ──
      if(cmd==='scratch_user'){ const r=await CW.scratchUser(interaction.options.getString('username')); await reply(r.replace(/\[.*?\]/g,'').substring(0,1900)); return; }
      if(cmd==='scratch_project'){ const r=await CW.scratchProject(interaction.options.getString('id')); await reply(r.replace(/\[.*?\]/g,'').substring(0,1900)); return; }

      // ── song_typing_info ──
      if(cmd==='song_typing_info'){ const r=await getSongTypingInfo(interaction.options.getString('id')); await reply(r.replace(/\[.*?\]/g,'').substring(0,1900)); return; }

      // ── romera ──
      if(cmd==='romera'){
        const d=await getTodayCounts(CW_ROOM);
        let msg='**今日のメッセージ数ランキング**\n';
        if(!d.rows.length){ msg+='今日のメッセージはまだないみたい。'; }
        else{ for(let i=0;i<d.rows.length;i++){ const n=await CW.nameById(d.rows[i].accountId,[],CW_ROOM); msg+=`${i+1}位：${n} ${d.rows[i].count}コメ\n`; } }
        msg+=`\n合計：${d.rows.reduce((s,r)=>s+r.count,0)}コメ（ぼく込み）`;
        await reply(msg, {title:'今日のメッセージ数ランキング'}); return;
      }

      // ── message_total ──
      if(cmd==='message_total'){
        const r=await dbQuery('SELECT account_id,message_count FROM total_message_counts WHERE room_id=$1 ORDER BY message_count DESC',[CW_ROOM]);
        if(!r.rows.length){ await reply('累計発言数はまだないみたい', {title:'累計発言数ランキング'}); return; }
        let msg='**累計発言数ランキング**\n';
        for(let i=0;i<r.rows.length;i++){ const n=await CW.nameById(r.rows[i].account_id,[],CW_ROOM); msg+=`${i+1}位：${n} ${r.rows[i].message_count}コメ\n`; }
        await reply(msg, {title:'累計発言数ランキング'}); return;
      }

      // ── alarm ──
      if(cmd==='alarm'){
        const dt=interaction.options.getString('datetime'); const msg=interaction.options.getString('message');
        const mx=dt.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})$/);
        if(!mx){ await reply('日時の形式がおかしいよ！例: `2026-04-10 15:30`'); return; }
        const t=new Date(`${mx[1]}T${mx[2]}:00+09:00`);
        await dbQuery('INSERT INTO alarms (room_id,discord_channel_id,scheduled_time,message,created_by) VALUES ($1,$2,$3,$4,$5)',[0,interaction.channelId,t,msg,0]);
        await reply(`⏰ アラームを設定したよ！\n**${t.toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}** に「${msg}」を送信するね`); return;
      }

      // ── miaq ──
      if(cmd==='miaq'){
        try{
          const tm=await interaction.channel.messages.fetch(interaction.options.getString('message_id'));
          if(!tm){ await reply('メッセージが見つからなかったよ'); return; }
          const r=await axios.post('https://makeit-a66a.onrender.com/',{text:tm.content||'',name:tm.member?.displayName||tm.author.username,id:tm.author.id},{headers:{'Content-Type':'application/json'},responseType:'arraybuffer',timeout:20000});
          await interaction.editReply({files:[new AttachmentBuilder(Buffer.from(r.data),{name:'quote.png'})]});
        } catch(e){ await replyErr(`エラーが発生したよ: ${e.message}`); }
        return;
      }

      // ── room_info ──
      if(cmd==='room_info'){
        if(!INFO_API_TOKEN){ await reply('INFO_API_TOKENが設定されていないよ'); return; }
        const rid=interaction.options.getString('room_id');
        const ri=await CW.roomInfoWithToken(rid,INFO_API_TOKEN);
        if(ri.error){ await replyErr(ri.error==='not_found'?'そのルームは見つからなかったよ':'ルーム情報の取得に失敗しちゃった'); return; }
        const ms=await CW.membersWithToken(rid,INFO_API_TOKEN);
        if(!ms.some(m=>String(m.account_id)===YUYUYU_ACCOUNT_ID)){ await replyErr('ますたーが参加していないルームだよ'); return; }
        const ip=ri.icon_path||''; const il=ip?(ip.startsWith('http')?ip:`https://appdata.chatwork.com${ip}`):'なし';
        await reply(null, {
          title: ri.name+'の情報',
          fields:[
            {name:'メンバー数', value:`${ms.length}人`, inline:true},
            {name:'管理者数', value:`${ms.filter(m=>m.role==='admin').length}人`, inline:true},
            {name:'ルームID', value:rid, inline:true},
            {name:'ファイル数', value:`${ri.file_num||0}`, inline:true},
            {name:'メッセージ数', value:`${ri.message_num||0}`, inline:true},
            {name:'アイコン', value:il, inline:false},
            {name:'管理者', value:ms.filter(m=>m.role==='admin').map(m=>m.name).join(', ')||'なし', inline:false},
          ]
        }); return;
      }

      // ━━ 以下、管理者専用 ━━

      // ── clear ──
      if(cmd==='clear'){
        if(!isAdmin){ await replyErr('管理者しか実行できないコマンドだよ！'); return; }
        const cnt=interaction.options.getInteger('count');
        const fetched=await interaction.channel.messages.fetch({limit:cnt});
        const del=fetched.filter(m=>(Date.now()-m.createdTimestamp)<14*24*60*60*1000);
        if(!del.size){ await reply('削除できるメッセージがないよ（14日以上前は削除不可）'); return; }
        await interaction.channel.bulkDelete(del,true);
        await reply(`${del.size}件のメッセージを削除したよ！`, {title:'削除完了', color:0xe74c3c}); return;
      }

      // ── prohibit ──
      if(cmd==='prohibit'){
        if(!isAdmin){ await replyErr('管理者しか実行できないコマンドだよ！'); return; }
        const a=interaction.options.getString('duration'); const mm=a.match(/^(\d+)m$/),hm=a.match(/^(\d+)h$/);
        let s=mm?parseInt(mm[1])*60:hm?parseInt(hm[1])*3600:0;
        if(s<=0||s>10800){ await reply('時間の指定がおかしいよ！5分なら `5m`、3時間なら `3h`（最大3時間）'); return; }
        const ea=new Date(Date.now()+s*1000);
        await dbQuery('INSERT INTO discord_prohibit (channel_id,ends_at) VALUES ($1,$2) ON CONFLICT (channel_id) DO UPDATE SET ends_at=$2',[interaction.channelId,ea]);
        await reply(`**${ea.toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}** まで発言禁止にしたよ！`, {title:'発言禁止', color:0xe74c3c}); return;
      }

      // ── release ──
      if(cmd==='release'){
        if(!isAdmin){ await replyErr('管理者しか実行できないコマンドだよ！'); return; }
        await dbQuery('DELETE FROM discord_prohibit WHERE channel_id=$1',[interaction.channelId]);
        await reply('このチャンネルの発言禁止を解除したよ！', {title:'発言禁止解除', color:0x2ecc71}); return;
      }

      // ── ban ──
      if(cmd==='ban'){
        if(!isAdmin){ await replyErr('管理者しか実行できないコマンドだよ！'); return; }
        if(!interaction.guild){ await replyErr('サーバー内でのみ使えるよ'); return; }
        const target=interaction.options.getUser('user');
        const reason=interaction.options.getString('reason')||'理由なし';
        try{
          await interaction.guild.members.ban(target.id,{reason:`${interaction.user.tag}: ${reason}`});
          await reply(`<@${target.id}>（${target.tag}）をBANしたよ\n理由: ${reason}`,{title:'BAN完了',color:0xe74c3c});
          // DMに通知
          target.send(`**${interaction.guild.name}** からBANされたよ\n理由: ${reason}`).catch(()=>{});
          // 管理者チャンネルにログ
          const adminChId=await getGuildChannel(interaction.guild.id,'admin');
          if(adminChId){const ch=interaction.guild.channels.cache.get(adminChId);if(ch)ch.send({embeds:[{title:'BAN実行',description:`対象: <@${target.id}>（${target.tag}）\n理由: ${reason}\n実行者: ${interaction.user.tag}`,color:0xe74c3c,footer:{text:new Date().toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}}]}).catch(()=>{});}
        }catch(e){ await replyErr(`BANに失敗したよ: ${e.message}`); }
        return;
      }

      // ── unban ──
      if(cmd==='unban'){
        if(!isAdmin){ await replyErr('管理者しか実行できないコマンドだよ！'); return; }
        if(!interaction.guild){ await replyErr('サーバー内でのみ使えるよ'); return; }
        const userId=interaction.options.getString('user-id');
        try{
          await interaction.guild.members.unban(userId);
          await reply(`ID:${userId} のBANを解除したよ`,{title:'BAN解除',color:0x2ecc71});
          const adminChId=await getGuildChannel(interaction.guild.id,'admin');
          if(adminChId){const ch=interaction.guild.channels.cache.get(adminChId);if(ch)ch.send({embeds:[{title:'BAN解除',description:`対象ID: ${userId}\n実行者: ${interaction.user.tag}`,color:0x2ecc71,footer:{text:new Date().toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}}]}).catch(()=>{});}
        }catch(e){ await replyErr(`BAN解除に失敗したよ: ${e.message}`); }
        return;
      }

      // ── blacklist ──
      if(cmd==='blacklist'){
        if(!isAdmin){ await replyErr('管理者しか実行できないコマンドだよ！'); return; }
        if(!interaction.guild){ await replyErr('サーバー内でのみ使えるよ'); return; }
        try{
          const bans=await interaction.guild.bans.fetch();
          if(!bans.size){ await reply('このサーバーのBANリストは空だよ',{title:'BANリスト'}); return; }
          const list=bans.map(b=>`・${b.user.tag}（${b.user.id}）${b.reason?` - ${b.reason}`:''}`).slice(0,20).join('\n');
          await reply(list+(bans.size>20?`\n…他${bans.size-20}件`:''),{title:`BANリスト（${bans.size}件）`});
        }catch(e){ await replyErr(`BANリスト取得に失敗したよ: ${e.message}`); }
        return;
      }

      // ── kick ──
      if(cmd==='kick'){
        if(!isAdmin){ await replyErr('管理者しか実行できないコマンドだよ！'); return; }
        if(!interaction.guild){ await replyErr('サーバー内でのみ使えるよ'); return; }
        const target=interaction.options.getUser('user');
        const reason=interaction.options.getString('reason')||'理由なし';
        try{
          const member=await interaction.guild.members.fetch(target.id).catch(()=>null);
          if(!member){ await replyErr('そのユーザーはこのサーバーにいないみたい'); return; }
          await member.kick(`${interaction.user.tag}: ${reason}`);
          await reply(`<@${target.id}>（${target.tag}）をキックしたよ\n理由: ${reason}`,{title:'キック完了',color:0xe74c3c});
          // DMに通知
          target.send(`**${interaction.guild.name}** からキックされたよ\n理由: ${reason}`).catch(()=>{});
          // 管理者チャンネルにログ
          const adminChId=await getGuildChannel(interaction.guild.id,'admin');
          if(adminChId){const ch=interaction.guild.channels.cache.get(adminChId);if(ch)ch.send({embeds:[{title:'キック実行',description:`対象: <@${target.id}>（${target.tag}）\n理由: ${reason}\n実行者: ${interaction.user.tag}`,color:0xe74c3c,footer:{text:new Date().toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}}]}).catch(()=>{});}
        }catch(e){ await replyErr(`キックに失敗したよ: ${e.message}`); }
        return;
      }

      // ── mute ──
      if(cmd==='mute'){
        if(!isAdmin){ await replyErr('管理者しか実行できないコマンドだよ！'); return; }
        if(!interaction.guild){ await replyErr('サーバー内でのみ使えるよ'); return; }
        const target=interaction.options.getUser('user');
        const minutes=interaction.options.getInteger('minutes')||30;
        try{
          const member=await interaction.guild.members.fetch(target.id).catch(()=>null);
          if(!member){ await replyErr('そのユーザーはこのサーバーにいないみたい'); return; }
          await member.timeout(minutes*60*1000,`${interaction.user.tag}: タイムアウト`);
          const until=new Date(Date.now()+minutes*60*1000).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});
          await reply(`<@${target.id}>（${target.tag}）を**${minutes}分**タイムアウトしたよ\n解除: ${until}`,{title:'タイムアウト完了',color:0xe74c3c});
          // DMに通知
          target.send(`**${interaction.guild.name}** でタイムアウトされたよ（${minutes}分）\n解除: ${until}`).catch(()=>{});
          // 管理者チャンネルにログ
          const adminChId=await getGuildChannel(interaction.guild.id,'admin');
          if(adminChId){const ch=interaction.guild.channels.cache.get(adminChId);if(ch)ch.send({embeds:[{title:'タイムアウト実行',description:`対象: <@${target.id}>（${target.tag}）\n時間: ${minutes}分\n実行者: ${interaction.user.tag}`,color:0xe74c3c,footer:{text:new Date().toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}}]}).catch(()=>{});}
        }catch(e){ await replyErr(`タイムアウトに失敗したよ: ${e.message}`); }
        return;
      }

      // ── fever ──
      if(cmd==='fever'){
        if(!isAdmin){ await replyErr('管理者しか実行できないコマンドだよ！'); return; }
        const a=interaction.options.getString('duration'); const mm=a.match(/^(\d+)m$/),hm=a.match(/^(\d+)h$/);
        let s=mm?parseInt(mm[1])*60:hm?parseInt(hm[1])*3600:0;
        if(s<=0||s>10800){ await reply('時間の指定がおかしいよ！5分なら `5m`、3時間なら `3h`（最大3時間）'); return; }
        const ea=new Date(Date.now()+s*1000);
        await dbQuery(`INSERT INTO fever (room_id,ends_at) VALUES ($1,$2) ON CONFLICT (room_id) DO UPDATE SET ends_at=$2`,[CW_ROOM,ea]);
        await reply(`**${ea.toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}** まで獲得ポイント10倍だよっ！`, {title:'フィーバータイム開始', color:0xf39c12}); return;
      }

      // ── ng_add ──
      if(cmd==='ng_add'){
        if(!isAdmin){ await replyErr('管理者しか実行できないコマンドだよ！'); return; }
        const w=interaction.options.getString('word');
        await dbQuery('INSERT INTO ng_words (room_id,word) VALUES ($1,$2) ON CONFLICT DO NOTHING',[CW_ROOM,w]);
        await reply(`「${w}」をNGワードに登録したよ！`, {title:'NGワード登録', color:0xe74c3c}); return;
      }

      // ── ng_del ──
      if(cmd==='ng_del'){
        if(!isAdmin){ await replyErr('管理者しか実行できないコマンドだよ！'); return; }
        const w=interaction.options.getString('word');
        await dbQuery('DELETE FROM ng_words WHERE room_id=$1 AND word=$2',[CW_ROOM,w]);
        await reply(`「${w}」をNGワードから削除したよ！`, {title:'NGワード削除', color:0x2ecc71}); return;
      }

      // ── ng_check ──
      if(cmd==='ng_check'){
        if(!isAdmin){ await replyErr('管理者しか実行できないコマンドだよ！'); return; }
        const r=await dbQuery('SELECT word FROM ng_words WHERE room_id=$1 ORDER BY created_at',[CW_ROOM]);
        if(!r.rows.length){ await reply('NGワードはまだ登録されてないよ', {title:'CW NGワード一覧'}); return; }
        await reply(r.rows.map(x=>`・${x.word}`).join('\n'), {title:'CW NGワード一覧'}); return;
      }
      if(cmd==='rank'){if(!interaction.guild){await replyErr('サーバー内でのみ使えるよ');return;}if(interaction.guild&&interaction.guild.id!==ALLOWED_GUILD_ID){await replyErr('このコマンドは指定サーバーでのみ使えるよ');return;}const uid=interaction.user.id;const r=await dbQuery('SELECT xp,level FROM discord_levels WHERE guild_id=$1 AND user_id=$2',[interaction.guild.id,uid]);const xp=r.rows.length?parseInt(r.rows[0].xp):0,lv=r.rows.length?parseInt(r.rows[0].level):0;const nextXp=totalXpForLevel(lv+1),role=getRoleForLevel(lv),ar=role?interaction.guild.roles.cache.get(role.roleId):null;await reply(null,{title:`${interaction.member.displayName} のランク`,fields:[{name:'レベル',value:`**${lv}**`,inline:true},{name:'XP',value:`${xp.toLocaleString()}`,inline:true},{name:'次のLvまで',value:`${(nextXp-xp).toLocaleString()} XP`,inline:true},{name:'現在のロール',value:ar?ar.name:'なし',inline:true}],color:role?0xf39c12:0x7289da,footer:`次のLv${lv+1}に必要な累計XP: ${nextXp.toLocaleString()}`});return;}
      if(cmd==='work'){if(!interaction.guild){await replyErr('サーバー内でのみ使えるよ');return;}if(interaction.guild&&interaction.guild.id!==ALLOWED_GUILD_ID){await replyErr('このコマンドは指定サーバーでのみ使えるよ');return;}const uid=interaction.user.id,gid=interaction.guild.id,eco=await getEconomy(gid,uid),lvRow=await dbQuery('SELECT level FROM discord_levels WHERE guild_id=$1 AND user_id=$2',[gid,uid]),lv=lvRow.rows.length?parseInt(lvRow.rows[0].level):0,limit=workLimitForLevel(lv),today=new Date().toLocaleDateString('ja-JP',{timeZone:'Asia/Tokyo'}),resetDate=eco.work_reset_date?new Date(eco.work_reset_date).toLocaleDateString('ja-JP',{timeZone:'Asia/Tokyo'}):null;let count=resetDate!==today?0:(eco.work_count||0);if(count>=limit){await replyErr(`今日の仕事回数上限（${limit}回）に達したよ！明日また来てね`);return;}if(eco.last_work_at){const diff=(Date.now()-new Date(eco.last_work_at).getTime())/60000;if(diff<30){await replyErr(`クールダウン中！あと**${Math.ceil(30-diff)}分**待ってね`);return;}}const job=JOBS[eco.job]||JOBS['ニート'],result=job.work(),newWallet=Math.max(0,parseInt(eco.wallet)+result.earned);await dbQuery('UPDATE discord_economy SET wallet=$1,work_count=$2,work_reset_date=CURRENT_DATE,last_work_at=NOW(),updated_at=NOW() WHERE guild_id=$3 AND user_id=$4',[newWallet,count+1,gid,uid]);await reply(result.msg+`\n\n所持金: **${fmt(newWallet)}** | 今日: ${count+1}/${limit}回`,{title:`${interaction.member.displayName} が${eco.job}として働いた！`,color:result.earned>0?0x2ecc71:result.earned<0?0xe74c3c:0x95a5a6,footer:`残りwork回数: ${limit-(count+1)}回`});return;}
      if(cmd==='job'){if(interaction.guild&&interaction.guild.id!==ALLOWED_GUILD_ID){await replyErr('このコマンドは指定サーバーでのみ使えるよ');return;}const tiers=['初級','中級','上級','特殊'];const fields=tiers.map(tier=>{const jobs=Object.entries(JOBS).filter(([,v])=>v.tier===tier);return{name:`【${tier}職】`,value:jobs.map(([n,v])=>`**${n}**（${v.cost>0?fmt(v.cost):'無料'}）\n${v.desc}`).join('\n\n'),inline:false};});await reply(null,{title:'職一覧',fields,color:0x7289da,footer:'転職は /job_set で。転職コストは所持金＋銀行の合計から判定'});return;}
      if(cmd==='job_info'){if(interaction.guild&&interaction.guild.id!==ALLOWED_GUILD_ID){await replyErr('このコマンドは指定サーバーでのみ使えるよ');return;}const jobName=interaction.options.getString('job'),job=JOBS[jobName];if(!job){await replyErr(`「${jobName}」という職は存在しないよ`);return;}await reply(job.desc,{title:job.tier+'職：'+jobName,fields:[{name:'転職コスト',value:job.cost>0?fmt(job.cost):'無料',inline:true},{name:'カテゴリ',value:job.tier,inline:true}],color:0x7289da});return;}
      if(cmd==='job_set'){if(!interaction.guild){await replyErr('サーバー内でのみ使えるよ');return;}if(interaction.guild&&interaction.guild.id!==ALLOWED_GUILD_ID){await replyErr('このコマンドは指定サーバーでのみ使えるよ');return;}const jobName=interaction.options.getString('job'),job=JOBS[jobName];if(!job){await replyErr(`「${jobName}」という職は存在しないよ\n/job で職一覧を確認してね`);return;}const uid=interaction.user.id,gid=interaction.guild.id,eco=await getEconomy(gid,uid);if(eco.job===jobName){await replyErr(`すでに${jobName}だよ`);return;}const total=parseInt(eco.wallet)+parseInt(eco.bank);if(total<job.cost){await replyErr(`転職コストが足りないよ！\n必要: ${fmt(job.cost)} / 所持: ${fmt(total)}`);return;}await dbQuery('UPDATE discord_economy SET job=$1,updated_at=NOW() WHERE guild_id=$2 AND user_id=$3',[jobName,gid,uid]);await reply(`**${jobName}**に転職したよ！\n${job.desc}`,{title:'転職完了',color:0x2ecc71});return;}
      if(cmd==='money'){if(!interaction.guild){await replyErr('サーバー内でのみ使えるよ');return;}if(interaction.guild&&interaction.guild.id!==ALLOWED_GUILD_ID){await replyErr('このコマンドは指定サーバーでのみ使えるよ');return;}const eco=await getEconomy(interaction.guild.id,interaction.user.id);await reply(null,{title:`${interaction.member.displayName} の所持金`,fields:[{name:'財布',value:`**${fmt(eco.wallet)}**`,inline:true},{name:'銀行',value:`**${fmt(eco.bank)}**`,inline:true},{name:'合計',value:`**${fmt(parseInt(eco.wallet)+parseInt(eco.bank))}**`,inline:true},{name:'職業',value:eco.job,inline:true}],color:0xf39c12});return;}
      if(cmd==='money_send'){if(!interaction.guild){await replyErr('サーバー内でのみ使えるよ');return;}if(interaction.guild&&interaction.guild.id!==ALLOWED_GUILD_ID){await replyErr('このコマンドは指定サーバーでのみ使えるよ');return;}const target=interaction.options.getUser('user'),amount=interaction.options.getInteger('amount'),gid=interaction.guild.id;if(target.id===interaction.user.id){await replyErr('自分には送れないよ');return;}if(target.bot){await replyErr('botには送れないよ');return;}const myEco=await getEconomy(gid,interaction.user.id);if(parseInt(myEco.wallet)<amount){await replyErr(`財布の残高が足りないよ！財布: ${fmt(myEco.wallet)}`);return;}await dbQuery('UPDATE discord_economy SET wallet=wallet-$1 WHERE guild_id=$2 AND user_id=$3',[amount,gid,interaction.user.id]);await getEconomy(gid,target.id);await dbQuery('UPDATE discord_economy SET wallet=wallet+$1 WHERE guild_id=$2 AND user_id=$3',[amount,gid,target.id]);await reply(`<@${target.id}> に **${fmt(amount)}** 送ったよ！`,{title:'送金完了',color:0x2ecc71});return;}
      if(cmd==='bank'){if(!interaction.guild){await replyErr('サーバー内でのみ使えるよ');return;}if(interaction.guild&&interaction.guild.id!==ALLOWED_GUILD_ID){await replyErr('このコマンドは指定サーバーでのみ使えるよ');return;}const eco=await getEconomy(interaction.guild.id,interaction.user.id);await reply(null,{title:`${interaction.member.displayName} の銀行`,fields:[{name:'銀行残高',value:`**${fmt(eco.bank)}**`,inline:true},{name:'財布',value:`**${fmt(eco.wallet)}**`,inline:true}],color:0x3498db});return;}
      if(cmd==='bank_deposit'){if(!interaction.guild){await replyErr('サーバー内でのみ使えるよ');return;}if(interaction.guild&&interaction.guild.id!==ALLOWED_GUILD_ID){await replyErr('このコマンドは指定サーバーでのみ使えるよ');return;}const amount=interaction.options.getInteger('amount'),gid=interaction.guild.id,uid=interaction.user.id,eco=await getEconomy(gid,uid);if(parseInt(eco.wallet)<amount){await replyErr(`財布の残高が足りないよ！財布: ${fmt(eco.wallet)}`);return;}await dbQuery('UPDATE discord_economy SET wallet=wallet-$1,bank=bank+$1,updated_at=NOW() WHERE guild_id=$2 AND user_id=$3',[amount,gid,uid]);await reply(`**${fmt(amount)}** を銀行に預けたよ！`,{title:'預け入れ完了',color:0x3498db});return;}
      if(cmd==='bank_withdraw'){if(!interaction.guild){await replyErr('サーバー内でのみ使えるよ');return;}if(interaction.guild&&interaction.guild.id!==ALLOWED_GUILD_ID){await replyErr('このコマンドは指定サーバーでのみ使えるよ');return;}const amount=interaction.options.getInteger('amount'),gid=interaction.guild.id,uid=interaction.user.id,eco=await getEconomy(gid,uid);if(parseInt(eco.bank)<amount){await replyErr(`銀行残高が足りないよ！銀行: ${fmt(eco.bank)}`);return;}await dbQuery('UPDATE discord_economy SET wallet=wallet+$1,bank=bank-$1,updated_at=NOW() WHERE guild_id=$2 AND user_id=$3',[amount,gid,uid]);await reply(`**${fmt(amount)}** を銀行から引き出したよ！`,{title:'引き出し完了',color:0x3498db});return;}
      if(cmd==='role_panel'){if(!isAdmin){await replyErr('管理者しか実行できないコマンドだよ！');return;}const title=interaction.options.getString('title');const options=[];for(let i=1;i<=24;i++){const role=interaction.options.getRole(`role${i}`);if(role)options.push({label:role.name,value:role.id});}if(!options.length){await replyErr('ロールを1つ以上指定してね');return;}const{ActionRowBuilder,StringSelectMenuBuilder}=require('discord.js');const menu=new StringSelectMenuBuilder().setCustomId('role_panel_select').setPlaceholder('ロールを選択してね（複数選択可）').setMinValues(0).setMaxValues(options.length).addOptions(options);await interaction.editReply({embeds:[{title,description:'メニューからロールを選択するとロールが付与・解除されるよ！',color:0x7289da}],components:[new ActionRowBuilder().addComponents(menu)],content:''});return;}
      if(cmd==='verify'){if(!isAdmin){await replyErr('管理者しか実行できないコマンドだよ！');return;}const role=interaction.options.getRole('role'),title=interaction.options.getString('title')||'認証',desc=interaction.options.getString('description')||'ボタンを押すと認証されてロールが付与されるよ！';const{ActionRowBuilder,ButtonBuilder,ButtonStyle}=require('discord.js');const btn=new ButtonBuilder().setCustomId(`verify_btn:${role.id}`).setLabel('認証する').setStyle(ButtonStyle.Primary);await interaction.editReply({embeds:[{title,description:desc,color:0x2ecc71,footer:{text:`付与されるロール: ${role.name}`}}],components:[new ActionRowBuilder().addComponents(btn)],content:''});return;}
      if(cmd==='event'){
        const sub=interaction.options.getSubcommand();
        if(sub==='add'){
          if(!isAdmin){await replyErr('管理者しか実行できないコマンドだよ！');return;}
          const date=interaction.options.getString('date'),content=interaction.options.getString('content');
          if(!/^\d{2}-\d{2}$/.test(date)){await replyErr('日付はMM-DD形式で入力してね（例: 06-15）');return;}
          await dbQuery('INSERT INTO events (event_date,content) VALUES ($1,$2) ON CONFLICT DO NOTHING',[date,content]);
          await reply(`**${date}** に「${content}」を登録したよ！`,{title:'イベント登録完了',color:0x2ecc71});return;
        }
        if(sub==='list'){
          const date=interaction.options.getString('date')||(()=>{const jst=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));return `${String(jst.getMonth()+1).padStart(2,'0')}-${String(jst.getDate()).padStart(2,'0')}`;})();
          const r=await dbQuery('SELECT id,content FROM events WHERE event_date=$1 ORDER BY created_at',[date]);
          if(!r.rows.length){await reply(`**${date}** にイベントはないよ`,{title:'イベント一覧'});return;}
          await reply(r.rows.map(row=>`ID:${row.id} ${row.content}`).join('\n'),{title:`${date} のイベント一覧`,color:0x7289da});return;
        }
        if(sub==='delete'){
          if(!isAdmin){await replyErr('管理者しか実行できないコマンドだよ！');return;}
          const id=interaction.options.getInteger('id');
          const r=await dbQuery('DELETE FROM events WHERE id=$1 RETURNING event_date,content',[id]);
          if(!r.rows.length){await replyErr(`ID:${id} のイベントは見つからなかったよ`);return;}
          await reply(`「${r.rows[0].content}」（${r.rows[0].event_date}）を削除したよ`,{title:'イベント削除完了',color:0xe74c3c});return;
        }
        return;
      }
      // ── join ──
      if(cmd==='join'){
        if(!interaction.guild){await replyErr('サーバー内でのみ使えるよ');return;}
        const vc=interaction.member.voice.channel;
        if(!vc){await replyErr('ボイスチャンネルに参加してから実行してね');return;}
        try{
          if(!voiceModule) throw new Error('@discordjs/voice未インストール');
          const {joinVoiceChannel,createAudioPlayer,entersState,VoiceConnectionStatus}=voiceModule;
          const connection=joinVoiceChannel({channelId:vc.id,guildId:interaction.guild.id,adapterCreator:interaction.guild.voiceAdapterCreator,selfDeaf:true});
          connection.on('debug', (m) => console.log('[VOICEVOX] connection debug:', m));
          connection.on('stateChange', (oldS,newS) => console.log(`[VOICEVOX] connection状態(join時): ${oldS.status} -> ${newS.status}`));
          await entersState(connection, VoiceConnectionStatus.Ready, 30000);
          const player=createAudioPlayer();
          connection.subscribe(player);
          voiceSessions.set(interaction.guild.id,{connection,player,channelId:vc.id,textChannelId:interaction.channelId,queue:[]});
          setupPlayerListeners(interaction.guild.id);
          console.log(`[VOICEVOX] VC接続完了 guild=${interaction.guild.id} channel=${vc.id}`);
          await reply(`**${vc.name}** に参加したよ！このテキストチャンネルの発言を読み上げるね`,{title:'VC参加',color:0x2ecc71});
        }catch(e){console.error('[VOICEVOX] join エラー:',e.message,e.stack);await replyErr(`ボイスチャンネルへの参加に失敗したよ…\n${e.message}`);}
        return;
      }
      // ── leave ──
      if(cmd==='leave'){
        if(!interaction.guild){await replyErr('サーバー内でのみ使えるよ');return;}
        const session=voiceSessions.get(interaction.guild.id);
        if(!session){await replyErr('ボイスチャンネルに参加してないよ');return;}
        session.connection.destroy();
        voiceSessions.delete(interaction.guild.id);
        await reply('ボイスチャンネルから退出したよ',{title:'VC退出',color:0x95a5a6});
        return;
      }
      // ── dictionary_add ──
      if(cmd==='dictionary_add'){
        if(!interaction.guild){await replyErr('サーバー内でのみ使えるよ');return;}
        const word=interaction.options.getString('word'),reading=interaction.options.getString('reading');
        await dbQuery('INSERT INTO voice_dictionary (guild_id,word,reading) VALUES ($1,$2,$3) ON CONFLICT (guild_id,word) DO UPDATE SET reading=$3',[interaction.guild.id,word,reading]);
        await reply(`「${word}」→「${reading}」を辞書に追加したよ！`,{title:'辞書登録完了',color:0x2ecc71});
        return;
      }
      // ── dictionary_list ──
      if(cmd==='dictionary_list'){
        if(!interaction.guild){await replyErr('サーバー内でのみ使えるよ');return;}
        const page=Math.max(1,interaction.options.getInteger('page')||1);
        const r=await dbQuery('SELECT word,reading FROM voice_dictionary WHERE guild_id=$1 ORDER BY created_at',[interaction.guild.id]);
        if(!r.rows.length){await reply('辞書は空だよ',{title:'読み上げ辞書一覧'});return;}
        const perPage=5,totalPages=Math.ceil(r.rows.length/perPage);
        const items=r.rows.slice((page-1)*perPage,page*perPage);
        await reply(items.map(i=>`**${i.word}** → ${i.reading}`).join('\n'),{title:`読み上げ辞書一覧（${page}/${totalPages}ページ）`,color:0x7289da});
        return;
      }
      // ── dictionary_remove ──
      if(cmd==='dictionary_remove'){
        if(!interaction.guild){await replyErr('サーバー内でのみ使えるよ');return;}
        const keyword=interaction.options.getString('keyword');
        const r=await dbQuery('DELETE FROM voice_dictionary WHERE guild_id=$1 AND (word=$2 OR reading=$2) RETURNING word,reading',[interaction.guild.id,keyword]);
        if(!r.rows.length){await replyErr(`「${keyword}」に一致する辞書エントリは見つからなかったよ`);return;}
        await reply(`「${r.rows[0].word}」→「${r.rows[0].reading}」を辞書から削除したよ`,{title:'辞書削除完了',color:0xe74c3c});
        return;
      }
      // ── pitch / speed / intonation ──
      if(cmd==='pitch'||cmd==='speed'||cmd==='intonation'){
        const value=interaction.options.getNumber('value');
        const col=cmd;
        const isDM=!interaction.guild;
        const scope=isDM?'user':'user'; // DM/サーバー問わずユーザー設定を更新（仕様: ユーザー優先）
        const targetId=interaction.user.id;
        // ただしサーバー内で実行した場合は「個人設定が無ければサーバー設定」のため、明示的に両方使い分ける
        if(isDM){
          await dbQuery(`INSERT INTO voice_settings (scope,target_id,${col}) VALUES ('user',$1,$2) ON CONFLICT (scope,target_id) DO UPDATE SET ${col}=$2,updated_at=NOW()`,[targetId,value]);
          await reply(`あなたの${col}を**${value}**に設定したよ（個人設定）`,{title:'設定変更',color:0x2ecc71});
        } else {
          await dbQuery(`INSERT INTO voice_settings (scope,target_id,${col}) VALUES ('guild',$1,$2) ON CONFLICT (scope,target_id) DO UPDATE SET ${col}=$2,updated_at=NOW()`,[interaction.guild.id,value]);
          await reply(`このサーバーの${col}を**${value}**に設定したよ（個人設定がある人はそちらが優先されるよ）`,{title:'設定変更',color:0x2ecc71});
        }
        return;
      }
      // ── speaker ──
      if(cmd==='speaker'){
        const id=interaction.options.getInteger('id');
        const speakers=await fetchVoicevoxSpeakers();
        if(!speakers[id]){await replyErr('そのIDの話者は見つからなかったよ。/speaker_list で確認してね');return;}
        const isDM=!interaction.guild;
        if(isDM){
          await dbQuery(`INSERT INTO voice_settings (scope,target_id,speaker_id) VALUES ('user',$1,$2) ON CONFLICT (scope,target_id) DO UPDATE SET speaker_id=$2,updated_at=NOW()`,[interaction.user.id,id]);
          await reply(`あなたの話者を**${speakers[id].charName}（${speakers[id].styleName}）**に設定したよ`,{title:'話者変更',color:0x2ecc71});
        } else {
          await dbQuery(`INSERT INTO voice_settings (scope,target_id,speaker_id) VALUES ('guild',$1,$2) ON CONFLICT (scope,target_id) DO UPDATE SET speaker_id=$2,updated_at=NOW()`,[interaction.guild.id,id]);
          await reply(`このサーバーの話者を**${speakers[id].charName}（${speakers[id].styleName}）**に設定したよ`,{title:'話者変更',color:0x2ecc71});
        }
        return;
      }
      // ── speaker_list ──
      if(cmd==='speaker_list'){
        const page=Math.max(1,interaction.options.getInteger('page')||1);
        const speakers=await fetchVoicevoxSpeakers();
        const entries=Object.entries(speakers);
        if(!entries.length){await replyErr('話者一覧の取得に失敗したよ');return;}
        const perPage=10,totalPages=Math.ceil(entries.length/perPage);
        const items=entries.slice((page-1)*perPage,page*perPage);
        await reply(items.map(([id,s])=>`**ID:${id}** ${s.charName}（${s.styleName}）`).join('\n'),{title:`話者一覧（${page}/${totalPages}ページ）`,color:0x7289da});
        return;
      }
      // ── discord_ng_add ──
      if(cmd==='discord_ng_add'){
        if(!isAdmin){await replyErr('管理者しか実行できないコマンドだよ！');return;}
        if(!interaction.guild){await replyErr('サーバー内でのみ使えるよ');return;}
        const pattern=interaction.options.getString('pattern');
        const isRegex=interaction.options.getBoolean('is_regex')||false;
        if(isRegex){try{new RegExp(pattern);}catch{await replyErr('正規表現の書式が正しくないよ');return;}}
        await dbQuery('INSERT INTO discord_ng_words (guild_id,pattern,is_regex) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',[interaction.guild.id,pattern,isRegex]);
        await reply(`「${pattern}」をDiscord NGワードに登録したよ！${isRegex?' (正規表現)':''}`,{title:'Discord NGワード登録',color:0xe74c3c});return;
      }
      // ── discord_ng_list ──
      if(cmd==='discord_ng_list'){
        if(!isAdmin){await replyErr('管理者しか実行できないコマンドだよ！');return;}
        if(!interaction.guild){await replyErr('サーバー内でのみ使えるよ');return;}
        const r=await dbQuery('SELECT id,pattern,is_regex FROM discord_ng_words WHERE guild_id=$1 ORDER BY id',[interaction.guild.id]);
        const ex=await dbQuery('SELECT channel_id FROM discord_ng_exclude_channels WHERE guild_id=$1',[interaction.guild.id]);
        if(!r.rowCount){await reply('NGワードはまだないよ',{title:'Discord NGワード一覧'});return;}
        const list=r.rows.map(row=>`ID:${row.id} ${row.is_regex?'[正規表現]':''} \`${row.pattern}\``).join('\n');
        const exList=ex.rows.map(row=>`<#${row.channel_id}>`).join(' ')||'なし';
        await reply(`${list}\n\n**除外チャンネル：** ${exList}`,{title:'Discord NGワード一覧'});return;
      }
      // ── discord_ng_remove ──
      if(cmd==='discord_ng_remove'){
        if(!isAdmin){await replyErr('管理者しか実行できないコマンドだよ！');return;}
        if(!interaction.guild){await replyErr('サーバー内でのみ使えるよ');return;}
        const id=interaction.options.getInteger('id');
        const r=await dbQuery('DELETE FROM discord_ng_words WHERE id=$1 AND guild_id=$2 RETURNING pattern',[id,interaction.guild.id]);
        if(!r.rowCount){await replyErr(`ID:${id} のNGワードは見つからなかったよ`);return;}
        await reply(`「${r.rows[0].pattern}」を削除したよ`,{title:'Discord NGワード削除',color:0x2ecc71});return;
      }
      // ── discord_ng_exclude ──
      if(cmd==='discord_ng_exclude'){
        if(!isAdmin){await replyErr('管理者しか実行できないコマンドだよ！');return;}
        if(!interaction.guild){await replyErr('サーバー内でのみ使えるよ');return;}
        const chId=interaction.channelId;
        const ex=await dbQuery('SELECT 1 FROM discord_ng_exclude_channels WHERE guild_id=$1 AND channel_id=$2',[interaction.guild.id,chId]);
        if(ex.rowCount>0){
          await dbQuery('DELETE FROM discord_ng_exclude_channels WHERE guild_id=$1 AND channel_id=$2',[interaction.guild.id,chId]);
          await reply('このチャンネルの除外設定を解除したよ',{title:'除外解除',color:0x2ecc71});
        }else{
          await dbQuery('INSERT INTO discord_ng_exclude_channels (guild_id,channel_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[interaction.guild.id,chId]);
          await reply('このチャンネルをNGワードチェックから除外したよ',{title:'除外設定',color:0xf39c12});
        }
        return;
      }
      // ── discord_warning_reset ──
      if(cmd==='discord_warning_reset'){
        if(!isAdmin){await replyErr('管理者しか実行できないコマンドだよ！');return;}
        if(!interaction.guild){await replyErr('サーバー内でのみ使えるよ');return;}
        const target=interaction.options.getUser('user');
        await dbQuery('UPDATE discord_warnings SET count=0,updated_at=NOW() WHERE guild_id=$1 AND user_id=$2',[interaction.guild.id,target.id]);
        await reply(`<@${target.id}> の警告回数をリセットしたよ`,{title:'警告リセット',color:0x2ecc71});return;
      }
      // ── server_status ──
      if(cmd==='server_status'){
        if(!isAdmin){await replyErr('管理者しか実行できないコマンドだよ！');return;}
        if(!interaction.guild){await replyErr('サーバー内でのみ使えるよ');return;}
        await reply('サーバー概要カテゴリを作成中…少し待ってね',{title:'Server Status',color:0x7289da});
        await ensureServerStatusChannels(interaction.guild);
        await updateServerStatus(interaction.guild);
        await interaction.editReply({embeds:[{title:'Server Status',description:'サーバー概要カテゴリを作成して1分毎に更新するよ！',color:0x2ecc71}],content:''});
        return;
      }

      // ── チャンネル設定コマンド ──
      const CH_CMD_MAP = {
        'eew': {label:'地震情報', type:'eew'},
        'join notice': {label:'入室通知', type:'join_notice'},
        'leveling': {label:'レベルアップ通知', type:'leveling'},
        'chatwork': {label:'Chatwork連携', type:'chatwork'},
        'bbs': {label:'掲示板連携', type:'bbs'},
        'admin': {label:'管理者', type:'admin'},
        'log': {label:'ログ', type:'log'},
      };
      if(CH_CMD_MAP[cmd]){
        if(!isAdmin){await replyErr('管理者しか実行できないコマンドだよ！');return;}
        if(!interaction.guild){await replyErr('サーバー内でのみ使えるよ');return;}
        const def = CH_CMD_MAP[cmd];
        await setGuildChannel(interaction.guild.id, def.type, interaction.channelId);
        await reply(`このチャンネルを**${def.label}チャンネル**に設定したよ！`,{title:'チャンネル設定',color:0x2ecc71});
        return;
      }

      await reply('不明なコマンドだよ', {color:0xe74c3c});
    } catch(e){
      console.error('[Discord] コマンドエラー:',e.message);
      try{ if(!interaction.replied&&!interaction.deferred) await interaction.reply('エラーが発生したよ'); else await reply('エラーが発生したよ'); } catch{}
    }
  });

  // Discord → Chatwork転送 + 投稿規制 + メッセージ反応
  discordClient.on(Events.MessageCreate, async(message)=>{
    try{
      // 自分自身（このbot）のメッセージは全てスキップ
      if(message.author.id === DISCORD_BOT_USER_ID) return;
      if(message.author.id === discordClient.user?.id) return;

      // ━━ 許可サーバー以外ではサーバー内機能を全て無効（DMは対象外なので素通り） ━━
      // ※ メッセージ反応（おみくじ等）はどのサーバーでも動く
      // XP加算・CW転送・投稿規制は許可サーバーのみ
      const isAllowedGuild = !message.guild || message.guild.id === ALLOWED_GUILD_ID;

      // ━━ VOICEVOX読み上げ（VC接続中のテキストチャンネルのみ、bot以外） ━━
      if(message.guild && !message.author.bot){
        const session = voiceSessions.get(message.guild.id);
        if(session && session.textChannelId === message.channel.id){
          const speechText = buildSpeechText(message);
          console.log(`[VOICEVOX] メッセージ検知: text="${speechText}" channel=${message.channel.id}`);
          if(speechText){
            (async()=>{
              try{
                const dictApplied = await applyDictionary(message.guild.id, speechText);
                const settings = await getVoiceSettings(message.guild.id, message.author.id);
                console.log(`[VOICEVOX] 読み上げキュー追加: "${dictApplied}" settings=${JSON.stringify(settings)}`);
                await enqueueSpeech(message.guild.id, dictApplied, settings);
              }catch(e){ console.error('[VOICEVOX] 読み上げエラー:', e.message); }
            })();
          }
        }
      }

      const content = message.content || '';
      if(!content && !(message.attachments && message.attachments.size>0)) return;

      const isDM = !message.guild;
      const isAdmin = isDM ? false : (message.member?.permissions?.has(PermissionFlagsBits.ManageMessages)||false);
      const trimmed = content.trim();

      // ━━ メッセージ反応（ALLOWED_GUILDかつ公開チャンネルのみ、DMは除外） ━━
      // プライベートチャンネル判定: @everyoneがViewChannelを持っていないチャンネルは非公開
      const isPublicChannel = !isDM && message.guild && message.guild.id === ALLOWED_GUILD_ID && (() => {
        const everyonePerms = message.channel.permissionsFor(message.guild.roles.everyone);
        return everyonePerms?.has(PermissionFlagsBits.ViewChannel) ?? false;
      })();

      if(isPublicChannel){
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
      }

      // ━━ サーバー内のみ: XP加算・NGワードチェック・投稿規制（許可サーバーのみ） ━━
      if(!isDM && !message.author.bot && isAllowedGuild){
        // 総メッセージ数カウントアップ
        dbQuery(`INSERT INTO discord_message_counts (guild_id,count) VALUES ($1,1)
          ON CONFLICT (guild_id) DO UPDATE SET count=discord_message_counts.count+1`,
          [message.guild.id]).catch(()=>{});

        // Discord NGワードチェック（全サーバー対象）
        await checkDiscordNgWords(message).catch(()=>{});
        // メッセージが削除されていたら後続処理をスキップ
        if(!message.channel) return;

        addDiscordXp(message.member, message.guild.id).catch(()=>{});
        if(!isAdmin){
          const pr=await dbQuery('SELECT ends_at FROM discord_prohibit WHERE channel_id=$1 AND ends_at>NOW()',[message.channel.id]);
          if(pr.rowCount>0){
            await message.delete().catch(()=>{});
            const w=await message.channel.send(`<@${message.author.id}> 現在このチャンネルは発言禁止中だよ！`).catch(()=>null);
            if(w)setTimeout(()=>w.delete().catch(()=>{}),5000);
            return;
          }
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
        if(cwId){
          // このCWメッセージIDをキャッシュ（1分間）→CW→Discord転送をスキップさせる
          addCwMsgFromDiscord(cwId);
          if(!message.author.bot){
            await dbQuery('INSERT INTO discord_bridge (cw_message_id,discord_message_id,cw_account_id) VALUES ($1,$2,$3)',
              [String(cwId), message.id, '0']).catch(()=>{});
          }
        }
      }
    } catch(e){ console.error('[Discord] MessageCreate エラー:',e.message); }
  });
  discordClient.on(Events.GuildMemberAdd,async(member)=>{
    if(member.guild.id!==ALLOWED_GUILD_ID)return;
    try{
      // /join-noticeで設定したチャンネル優先、なければ固定チャンネル
      const chId = await getGuildChannel(member.guild.id,'join_notice') || DISCORD_WELCOME_CHANNEL_ID;
      const ch=await discordClient.channels.fetch(chId).catch(()=>null);
      if(!ch)return;
      await member.guild.members.fetch();
      const cnt=member.guild.members.cache.filter(m=>!m.user.bot).size;
      await ch.send({embeds:[{
        title:`${member.displayName}さんこんにちは！`,
        description:`現在のサーバーメンバーは**${cnt}人**です！\n<#${DISCORD_RULES_CHANNEL_ID}> の確認と <#${DISCORD_INTRO_CHANNEL_ID}> をお願いします！`,
        color:0x7289da,thumbnail:{url:member.user.displayAvatarURL()}
      }]});
    }catch(e){console.error('[Discord]ようこそ:',e.message);}
  });

  // 全チャンネルのログをlogチャンネルに送信
  discordClient.on(Events.MessageCreate, async(msg)=>{
    if(msg.author.bot||!msg.guild||msg.author.id===DISCORD_BOT_USER_ID) return;
    try{
      const logChId = await getGuildChannel(msg.guild.id,'log');
      if(!logChId||logChId===msg.channel.id) return;
      const logCh = msg.guild.channels.cache.get(logChId);
      if(!logCh) return;
      await logCh.send({embeds:[{
        description: msg.content||'(添付ファイル)',
        color:0x2d2d2d,
        author:{name:`${msg.author.tag}`,icon_url:msg.author.displayAvatarURL()},
        footer:{text:`#${msg.channel.name} | ${msg.createdAt.toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}`}
      }]});
    }catch{}
  });
  discordClient.on(Events.InteractionCreate,async(interaction)=>{if(!interaction.isStringSelectMenu()||interaction.customId!=='role_panel_select')return;try{await interaction.deferReply({ephemeral:true});const member=interaction.member,guild=interaction.guild,selected=new Set(interaction.values),allOpts=interaction.component.options.map(o=>o.value),added=[],removed=[];for(const roleId of allOpts){const role=guild.roles.cache.get(roleId);if(!role)continue;const has=member.roles.cache.has(roleId);if(selected.has(roleId)&&!has){await member.roles.add(role).catch(()=>{});added.push(role.name);}else if(!selected.has(roleId)&&has){await member.roles.remove(role).catch(()=>{});removed.push(role.name);}}const lines=[];if(added.length)lines.push(`付与：${added.join('、')}`);if(removed.length)lines.push(`解除：${removed.join('、')}`);await interaction.editReply({embeds:[{title:'ロール更新完了',description:lines.length?lines.join('\n'):'変更なし',color:0x2ecc71}]});}catch(e){console.error('[Discord]ロールパネル:',e.message);try{await interaction.editReply({embeds:[{title:'エラー',description:'ロールの更新に失敗したよ',color:0xe74c3c}]});}catch{}}});
  discordClient.on(Events.InteractionCreate,async(interaction)=>{if(!interaction.isButton()||!interaction.customId.startsWith('verify_btn:'))return;try{await interaction.deferReply({ephemeral:true});const roleId=interaction.customId.split(':')[1],member=interaction.member;if(member.roles.cache.has(roleId)){await interaction.editReply({embeds:[{description:'すでに認証済みだよ！',color:0x2ecc71}]});return;}const role=interaction.guild.roles.cache.get(roleId)||await interaction.guild.roles.fetch(roleId).catch(()=>null);if(!role){await interaction.editReply({embeds:[{description:'ロールが見つからなかったよ',color:0xe74c3c}]});return;}await member.roles.add(role);await interaction.editReply({embeds:[{description:`認証完了！**${role.name}**が付与されたよ！`,color:0x2ecc71}]});}catch(e){console.error('[Discord]認証ボタン:',e.message);try{await interaction.editReply({embeds:[{description:'認証に失敗したよ…',color:0xe74c3c}]});}catch{}}});


  discordClient.login(DISCORD_BOT_TOKEN).catch(e=>console.error('[Discord] ログインエラー:',e.message));
}

// ============================================================
// 地震bot（p2pquake WebSocket）
// ============================================================
const EEW_INTENSITY_COLORS = {
  '1':'#00cfff','2':'#0080ff','3':'#00d000','4':'#ffd700',
  '5弱':'#ff8c00','5強':'#ff4500','6弱':'#cc0000','6強':'#990000','7':'#8b00ff'
};

function intensityColor(intensity) {
  return EEW_INTENSITY_COLORS[intensity] || '#aaaaaa';
}

// Leaflet地図のHTMLを生成
function generateQuakeMapHtml(quake) {
  const points = (quake.points||[]).filter(p=>p.isObserved);
  const epicenter = quake.earthquake?.hypocenter;
  const markers = points.map(p=>{
    const color = intensityColor(p.scale_label||String(p.scale));
    return `L.circleMarker([${p.lat},${p.lng}],{radius:8,color:'${color}',fillColor:'${color}',fillOpacity:0.85,weight:2})
      .bindPopup('<b>${p.addr}</b><br>震度${p.scale_label||p.scale}').addTo(map);`;
  }).join('\n');

  const epicenterJs = epicenter?.latitude ? `
    L.marker([${epicenter.latitude},${epicenter.longitude}],{
      icon:L.divIcon({html:'<div style="font-size:24px;color:red;">✕</div>',iconAnchor:[12,12]})
    }).bindPopup('<b>震源</b><br>${epicenter.name||''}').addTo(map);
  ` : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>body{margin:0}#map{width:600px;height:450px}</style></head>
<body><div id="map"></div><script>
const map=L.map('map',{zoomControl:false}).setView([36,137],5);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'OSM'}).addTo(map);
${markers}
${epicenterJs}
</script></body></html>`;
}

// p2pquake WebSocket接続
let eewWs = null;
function connectEewWebSocket() {
  try {
    const WebSocket = require('ws');
    eewWs = new WebSocket('wss://ws-api.p2pquake.net/v2/ws');
    eewWs.on('open', ()=>console.log('[EEW] WebSocket接続完了'));
    eewWs.on('message', async(data)=>{
      try {
        const msg = JSON.parse(data.toString());
        // code 551: 地震情報 / code 556: 緊急地震速報（警報）
        if(msg.code!==551 && msg.code!==556) return;
        if(!discordClient) return;

        // EEWチャンネルが設定されているサーバーに送信
        const rows = (await dbQuery("SELECT guild_id,channel_id FROM guild_channels WHERE channel_type='eew'")).rows;
        if(!rows.length) return;

        const isEEW = msg.code===556;
        const eq = msg.earthquake||{};
        const hypo = eq.hypocenter||{};
        const maxInt = msg.points ? msg.points.reduce((m,p)=>Math.max(m,p.scale||0),0) : 0;
        const intLabel = Object.keys(EEW_INTENSITY_COLORS)[Math.max(0,maxInt-1)] || String(maxInt);
        const color = isEEW ? 0xFFD700 : parseInt((intensityColor(intLabel)||'#7289da').replace('#',''),16);

        const embed = {
          title: isEEW ? '緊急地震速報（警報）' : '地震情報',
          color,
          fields: [
            {name:'震源',value:hypo.name||'不明',inline:true},
            {name:'マグニチュード',value:String(hypo.magnitude||'不明'),inline:true},
            {name:'深さ',value:hypo.depth!=null?`${hypo.depth}km`:'不明',inline:true},
            {name:'最大震度',value:intLabel||'不明',inline:true},
            {name:'発生時刻',value:msg.time||new Date().toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}),inline:true},
          ],
          footer:{text: isEEW?'⚠️ 緊急地震速報（警報）':'地震情報 | p2pquake'}
        };

        // 緊急地震速報は全文黄色背景のためembedのcolorを黄色に
        for(const row of rows) {
          try {
            const ch = await discordClient.channels.fetch(row.channel_id).catch(()=>null);
            if(!ch) continue;

            // 地図HTMLを生成してBufferで添付
            const mapHtml = generateQuakeMapHtml(msg);
            const { AttachmentBuilder:AB } = require('discord.js');
            const attachment = new AB(Buffer.from(mapHtml,'utf-8'),{name:'quake_map.html'});
            await ch.send({content: isEEW?'🚨 **緊急地震速報（警報）**':null, embeds:[embed], files:[attachment]});
          } catch(e){console.error('[EEW] 送信エラー:',e.message);}
        }
      } catch(e){console.error('[EEW] メッセージ処理エラー:',e.message);}
    });
    eewWs.on('close', ()=>{
      console.log('[EEW] WebSocket切断。10秒後に再接続...');
      setTimeout(connectEewWebSocket, 10000);
    });
    eewWs.on('error', (e)=>console.error('[EEW] WebSocketエラー:',e.message));
  } catch(e) {
    console.error('[EEW] WebSocket初期化失敗:',e.message);
    setTimeout(connectEewWebSocket, 30000);
  }
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

  // 地震bot WebSocket接続開始（wsパッケージが必要）
  try { require('ws'); connectEewWebSocket(); } catch(e){ console.error('[EEW] wsパッケージ未インストール:', e.message); }

  console.log('=== 起動完了！ ===\n');
});