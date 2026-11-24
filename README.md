# 🏸 バド基礎トレ

バドミントンの基礎トレ（体幹・フットワーク）を音声カウントダウンで実施し、記録と連続日数（🔥ストリーク）を残す Web アプリ（PWA）です。
GitHub に push すると Cloud Run に自動デプロイされます。

## 機能
- **ホームからワンタップ開始**：メニューカードをタップ → 5秒前カウント → メニュー名を読み上げ → カウントダウン
- **音声ガイド**：開始前は残り3秒から「さん・に・いち」→「スタート」、トレーニング残り3秒から音声カウントで終了、インターバルは残り5秒からカウントして次のメニューへ
- **メニュー作成**：体幹／フットワークを選択 → メニュー名・秒数 → インターバル（なし／あり＋秒数）→「次のメニューを追加」→「終了して保存」
- **連続記録**：Duolingo 風の🔥連続日数・直近7日・月カレンダー・最高記録・累計
- 一時停止／スキップ／中止、画面スリープ防止、オフライン動作、ホーム画面に追加可能

> データは端末のブラウザ（localStorage）に保存されます。機種変更やブラウザのデータ削除で消えるので注意。

## フォルダ構成
```
public/            アプリ本体（HTML/CSS/JS、PWA）
nginx.conf         配信設定（8080番ポート）
Dockerfile         Cloud Run 用イメージ
.github/workflows/deploy.yml   main への push で Cloud Run にデプロイ
```

## ローカルで動かす
```bash
cd public && python3 -m http.server 8080
# → http://localhost:8080
```

## デプロイ方法（どちらか一方）

### A. いちばん簡単：Cloud Run の「GitHub から継続的デプロイ」
1. このフォルダを GitHub の新しいリポジトリに push
2. Google Cloud コンソール → Cloud Run →「サービスを作成」→「リポジトリから継続的にデプロイする」
3. GitHub 連携して対象リポジトリ・ブランチ `main` を選択、ビルドタイプは **Dockerfile**
4. リージョン `asia-northeast1`、認証は「未認証の呼び出しを許可」、コンテナポート `8080`
5. 作成 → 以後 main に push するたびに自動デプロイ

（この方法なら `.github/workflows/deploy.yml` は削除してOK）

### B. GitHub Actions でデプロイ（同梱のワークフロー）
初回だけ Cloud Shell で以下を実行（`PROJECT_ID` と `GITHUB_REPO=ユーザー名/リポジトリ名` を置き換え）：

```bash
PROJECT_ID=your-project-id
GITHUB_REPO=your-name/badminton-training
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
SA=github-deployer@$PROJECT_ID.iam.gserviceaccount.com

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com iamcredentials.googleapis.com --project $PROJECT_ID

gcloud iam service-accounts create github-deployer --project $PROJECT_ID
for ROLE in roles/run.admin roles/cloudbuild.builds.editor roles/artifactregistry.admin roles/storage.admin roles/iam.serviceAccountUser roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$SA" --role=$ROLE
done

gcloud iam workload-identity-pools create github --location=global --project $PROJECT_ID
gcloud iam workload-identity-pools providers create-oidc github \
  --location=global --workload-identity-pool=github --project $PROJECT_ID \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='$GITHUB_REPO'"

gcloud iam service-accounts add-iam-policy-binding $SA --project $PROJECT_ID \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$GITHUB_REPO"

echo "WIF_PROVIDER = projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github"
echo "WIF_SERVICE_ACCOUNT = $SA"
```

GitHub リポジトリの **Settings → Secrets and variables → Actions** に、表示された2つを登録：
- `WIF_PROVIDER`
- `WIF_SERVICE_ACCOUNT`

あとは `main` に push すると Actions が走り、ログの最後に公開 URL が出ます。

## カスタマイズ
- 開始前カウント秒数・音声カウント開始秒数：`public/app.js` 冒頭の `PREP_SEC` / `REST_COUNT_FROM` / `WORK_COUNT_FROM`
- 種目の候補（チップ）：`PRESETS`
- アプリ更新がスマホに反映されないとき：`public/sw.js` の `VERSION` を上げる

## 補足
- 音声は端末の読み上げ機能（Web Speech API）を使います。iPhone はマナーモードだと音が出ないことがあります。
- 画面ロック中はブラウザの仕様でカウントが止まることがあるため、トレーニング中は画面をつけたままにしてください（スリープ防止は自動でかけています）。
