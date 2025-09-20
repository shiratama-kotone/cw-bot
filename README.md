# Chatwork Bot

Chatwork APIを使用したNode.jsベースのチャットボットです。Renderの無料プランとSupabase PostgreSQLで24時間稼働します。

## 機能

- 🎲 **おみくじ機能**: `おみくじ` で運勢占い
- 📅 **日付管理**: `/day-write` でイベント登録、`/today` で今日のイベント確認  
- 🤔 **Yes/No判定**: `/yes-or-no` でランダム回答
- 📊 **ボット状態確認**: `/status` で稼働状況表示
- 🔄 **自動復旧**: 再起動時の自動通知機能
- 📈 **統計記録**: 動作状況の詳細記録

## デプロイ手順

### 1. Supabase設定

1. [Supabase](https://supabase.com) でアカウント作成
2. 「New Project」でプロジェクト作成
3. **Settings** → **Database** → **Connection pooling** に移動
4. **Transaction** モードの接続文字列をコピー:
   ```
   postgresql://postgres.xxxxx:パスワード@xxxxx.pooler.supabase.com:6543/postgres
   ```

### 2. Render設定

1. [Render](https://render.com) でアカウント作成
2. **New** → **Web Service** を選択
3. **Connect a repository** でGitHubリポジトリを接続
4. 以下の設定を入力:

#### **基本設定**
- **Name**: `chatwork-bot`
- **Environment**: `Node`
- **Build Command**: `npm install`
- **Start Command**: `npm start`

#### **環境変数設定**
| Key | Value | 説明 |
|-----|-------|------|
| `DATABASE_URL` | `postgresql://postgres.xxxxx:パスワード@xxxxx.pooler.supabase.com:6543/postgres` | Supabaseから取得 |
| `CHATWORK_API_TOKEN` | `あなたのChatwork APIトークン` | ChatworkのAPI設定から取得 |
| `DIRECT_CHAT_WITH_DATE_CHANGE` | `405497983` | 日付変更メッセージを送信するダイレクトチャットID |
| `RENDER_EXTERNAL_URL` | `https://your-app-name.onrender.com` | デプロイ後のRender URL |

5. **Create Web Service** をクリック

### 3. UptimeRobot設定（スリープ防止）

1. [UptimeRobot](https://uptimerobot.com) で無料アカウント作成
2. **Add New Monitor** をクリック
3. 設定:
   - **Monitor Type**: HTTP(s)
   - **URL**: `https://your-app-name.onrender.com/health`
   - **Monitoring Interval**: 5 minutes
4. **Create Monitor** をクリック

### 4. Chatwork API Token取得

1. Chatworkにログイン
2. **設定** → **API** に移動
3. **新しいトークンを作成** をクリック
4. トークンをコピー

## 動作確認

デプロイ完了後、以下のエンドポイントで動作確認:

- **基本動作**: `https://your-app-name.onrender.com/`
- **ヘルスチェック**: `https://your-app-name.onrender.com/health`
- **統計情報**: `https://your-app-name.onrender.com/stats`

## 使用可能なコマンド

### 基本コマンド
| コマンド | 説明 | 使用例 | 対象 |
|----------|------|--------|------|
| `おみくじ` | 運勢を占います（管理者は特別おみくじの確率UP） | `おみくじ` | 全ルーム |
| `/yes-or-no` | Yes/Noでランダムに回答します | `/yes-or-no` | 全ルーム |
| `/today` | 今日の日付と登録されたイベントを表示 | `/today` | 全ルーム |
| `/status` | ボットの稼働状況を確認 | `/status` | 全ルーム |
| `/test` | あなたのアカウントIDを表示 | `/test` | 全ルーム |

### 日付・イベント管理
| コマンド | 説明 | 使用例 | 対象 |
|----------|------|--------|------|
| `/day-write` | 日付とイベントを登録 | `/day-write 2024-12-25 クリスマス` | 全ルーム |
| `/day-write` | 月日のみで登録（毎年） | `/day-write 12-25 クリスマス` | 全ルーム |
| `/day-write` | 日のみで登録（毎月） | `/day-write 25 給料日` | 全ルーム |

### 検索・情報取得
| コマンド | 説明 | 使用例 | 対象 |
|----------|------|--------|------|
| `/wiki/` | Wikipedia日本語版を検索 | `/wiki/東京タワー` | 全ルーム |
| `/scratch-user/` | Scratchユーザー情報を取得 | `/scratch-user/username` | 全ルーム |
| `/scratch-project/` | Scratchプロジェクト情報を取得 | `/scratch-project/123456` | 全ルーム |

### メンバー管理（グループチャットのみ）
| コマンド | 説明 | 使用例 | 対象 |
|----------|------|--------|------|
| `/member` | メンバー一覧をアイコン付きで表示 | `/member` | グループチャットのみ |
| `/member-name` | メンバー名一覧をテキストで表示 | `/member-name` | グループチャットのみ |

### 特定ユーザー呼び出し
| コマンド | 説明 | 使用例 | 対象 |
|----------|------|--------|------|
| `はんせい` | 特定ユーザー（なかよし）を呼び出し | `はんせい` | 全ルーム |
| `ゆゆゆ` | 特定ユーザー（ゆゆゆ）を呼び出し | `ゆゆゆ` | 全ルーム |
| `からめり` | 特定ユーザー（からめり）を呼び出し | `からめり` | 全ルーム |

### その他の応答
| コマンド | 説明 | 使用例 | 対象 |
|----------|------|--------|------|
| `いろいろあぷり` | アプリのURLを表示 | `いろいろあぷり` | 全ルーム |
| `おやすみ` | おやすみメッセージを返信 | `おやすみ` | 全ルーム |
| `おはよう` | おはようメッセージを返信 | `おはよう` | 全ルーム |
| `喘げ` | 特殊な応答 | `喘げ` | 全ルーム |
| `えろがきさんどこですかー` | 特定ユーザーを示す | `えろがきさんどこですかー` | 全ルーム |

### 自動機能
| 機能 | 説明 | 発動条件 | 対象 |
|------|------|----------|------|
| 日付変更通知 | 毎日0時0分に今日の情報を送信 | 自動（0時0分） | 設定されたルーム |
| Chatwork絵文字警告 | 絵文字を50個以上送信した場合の警告 | 絵文字50個以上（グループチャット） | グループチャットの非管理者 |
| [toall]検知 | [toall]使用を検知（権限変更機能は未実装） | [toall]使用時 | グループチャットの非管理者 |
| 再起動通知 | サーバー再起動時の自動通知 | サーバー再起動時 | 管理者向けルーム |

### 管理者向けルーム設定
再起動通知を受け取るルームを設定できます。現在は `404646956` が設定されています。

変更方法：
```javascript
// server.js内の該当箇所
const adminRoomIds = ['404646956', '他のルームID']; // 複数指定可能
```

## 技術仕様

- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Database**: PostgreSQL (Supabase)
- **Scheduling**: node-cron
- **Hosting**: Render (無料プラン)
- **Monitoring**: UptimeRobot

## アーキテクチャ

```
GitHub Repository
    ↓ (自動デプロイ)
Render Web Service
    ↓ (データベース接続)
Supabase PostgreSQL
    ↓ (API呼び出し)
Chatwork API
    ↓ (監視)
UptimeRobot (5分間隔ping)
```

## 制限事項

- **Renderの無料プラン**: 1日1回の自動再起動あり (ボットが自動復旧通知を送信)
- **API制限**: 過度の使用を防ぐためレート制限を実装
- **Supabase無料枠**: 500MBのデータベース容量

## トラブルシューティング

### ボットが応答しない場合
1. `/stats` エンドポイントで稼働状況を確認
2. Renderのログを確認
3. UptimeRobotの監視状況を確認

### データベース接続エラー
1. Supabaseプロジェクトの稼働状況を確認  
2. `DATABASE_URL` の環境変数が正しいか確認
3. `/db-test` エンドポイント（実装されている場合）でテスト

### Chatwork API エラー
1. APIトークンの有効性を確認
2. トークンの権限設定を確認
3. API制限に引っかかっていないか確認

## 貢献

バグ報告や機能追加の要望は [Issues](../../issues) までお願いします。

## ライセンス

MIT License

## 注意事項

- 本ツールは個人利用を想定しています
- ChatworkのAPI利用規約を遵守してください  
- 商用利用時は適切なプランへのアップグレードを検討してください
