# 湊音 Chatwork Bot セットアップ手順

## 1. 事前準備

### 必要なもの
- Chatwork APIトークン（2種類）
  - CHATWORK_API_TOKEN: メイン用
  - INFO_API_TOKEN: ルーム情報取得用
- Neon PostgreSQLアカウント
- Renderアカウント
- GitHubアカウント

## 2. データベース設定

### 2.1 Neon PostgreSQLでデータベース作成

1. https://neon.tech にアクセス
2. 新しいプロジェクトを作成
3. データベース名: `neondb`（任意）
4. リージョン: `ap-southeast-1`（シンガポール推奨）

### 2.2 データベーステーブル作成

1. Neonダッシュボードから「SQL Editor」を開く
2. `database_setup.sql`の内容をすべてコピー
3. SQL Editorに貼り付けて実行
4. 以下のテーブルが作成されます：
   - `webhooks` - WebHook受信ログ
   - `message_logs` - メッセージログ（ルーム415060980のみ）
   - `jirai_toggles` - 地雷トグル状態
   - `alarms` - アラーム設定
   - `total_message_counts` - 累計発言数

### 2.3 接続文字列を取得

1. Neonダッシュボードから「Connection String」をコピー
2. 形式: `postgresql://neondb_owner:PASSWORD@HOST/neondb?sslmode=require`
3. この文字列を後で使用します

## 3. GitHubリポジトリ準備

### 3.1 リポジトリ作成

```bash
# ローカルで新しいリポジトリを作成
mkdir chatwork-bot
cd chatwork-bot
git init

# server-complete.jsをserver.jsにリネーム
cp server-complete.js server.js

# package.jsonを作成
cat > package.json << 'EOF'
{
  "name": "chatwork-bot",
  "version": "1.0.0",
  "description": "湊音 Chatwork Bot",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "axios": "^1.6.0",
    "node-cron": "^3.0.2",
    "pg": "^8.11.0",
    "cheerio": "^1.0.0-rc.12"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
EOF

# GitHubにプッシュ
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/chatwork-bot.git
git push -u origin main
```

## 4. Renderデプロイ設定

### 4.1 新しいWeb Serviceを作成

1. https://render.com にログイン
2. 「New +」→「Web Service」をクリック
3. GitHubリポジトリを接続
4. 設定内容：
   - **Name**: `chatwork-bot-minato`（任意）
   - **Region**: `Singapore`
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free`

### 4.2 環境変数を設定

「Environment」タブで以下を追加：

| Key | Value |
|-----|-------|
| CHATWORK_API_TOKEN | あなたのChatwork APIトークン |
| INFO_API_TOKEN | あなたの情報取得用APIトークン |
| DATABASE_URL | Neonから取得した接続文字列 |
| DIRECT_CHAT_WITH_DATE_CHANGE | 405497983,407676893,415060980,406897783,391699365 |
| DAY_JSON_URL | https://raw.githubusercontent.com/shiratama-kotone/cw-bot/main/day.json |

### 4.3 デプロイ

「Create Web Service」をクリックしてデプロイを開始します。

## 5. Chatwork WebHook設定

### 5.1 WebHook URLを取得

デプロイ完了後、Renderのダッシュボードに表示されるURL：
```
https://chatwork-bot-minato.onrender.com
```

WebHook URL:
```
https://chatwork-bot-minato.onrender.com/webhook
```

### 5.2 各ルームでWebHookを設定

1. Chatworkの各ルームを開く
2. 右上の設定アイコン → 「Webhook設定」
3. 「追加」をクリック
4. WebHook URLを入力: `https://chatwork-bot-minato.onrender.com/webhook`
5. 「保存」をクリック

**設定が必要なルーム**:
- 405497983
- 407676893
- 415060980（ウェルカム&地雷の部屋）
- 406897783
- 391699365

## 6. 動作確認

### 6.1 起動確認

Renderのログで以下のメッセージを確認：
```
湊音がポート3000で起動しました
起動通知を送信するね...
起動かんりょ！
```

### 6.2 各ルームで起動通知確認

設定したルームに「湊音が起動したよっ！」が送信されます。

### 6.3 コマンドテスト

任意のルームで以下をテスト：
```
/test
```

→ アカウントIDが返信されれば成功

### 6.4 ステータス確認

ブラウザで以下にアクセス：
```
https://chatwork-bot-minato.onrender.com/status
```

JSON形式で現在の状態が表示されます：
```json
{
  "status": "元気！",
  "storage": "PostgreSQL + Memory",
  "logRoomId": "415060980",
  "logDestinationRoomId": "420890621",
  "botAccountId": "10386947",
  "jiraiToggles": { ... }
}
```

## 7. トラブルシューティング

### 起動しない

1. Renderのログを確認
2. 環境変数が正しく設定されているか確認
3. DATABASE_URLが正しいか確認

### データベースエラー

1. Neonのデータベースが起動しているか確認
2. SQL実行が完了しているか確認
3. テーブルが正しく作成されているか確認：
   ```sql
   SELECT table_name FROM information_schema.tables 
   WHERE table_schema = 'public';
   ```

### WebHookが動かない

1. WebHook URLが正しいか確認
2. Renderがスリープしていないか確認（Free版は25分後にスリープ）
3. Chatworkのルーム設定でWebHookが有効になっているか確認

### 地雷機能が動かない

1. `/jirai-test`で確率とルームIDを確認
2. ルームIDが415060980であることを確認
3. `/status`でトグル状態を確認

## 8. 初回起動後の処理

### 自動実行される処理

1. **メッセージカウント初期化** - 今日のメッセージをカウント
2. **累計発言数初期化** - webhooksテーブルから過去のメッセージを集計
3. **起動通知送信** - 各ルームに通知

### 累計発言数について

起動時に`webhooks`テーブルから過去のメッセージ数を自動集計します。
過去のメッセージがあれば、自動的に累計に反映されます。

## 9. 定期メンテナンス

### 自動実行されるメンテナンス

- **毎日0:05** - 2日前のメッセージログを自動削除
- **毎分** - アラームチェック＆送信

### 手動メンテナンス（必要に応じて）

- Renderのログ確認
- データベースの容量確認
- 不要なデータの削除

## 10. セットアップ完了チェックリスト

- [ ] Neon PostgreSQLデータベース作成
- [ ] database_setup.sql実行
- [ ] GitHubリポジトリ作成
- [ ] Renderにデプロイ
- [ ] 環境変数設定
- [ ] WebHook設定（全ルーム）
- [ ] 起動確認
- [ ] コマンドテスト
- [ ] ステータス確認

すべてチェックが入れば、セットアップ完了です！🎉
