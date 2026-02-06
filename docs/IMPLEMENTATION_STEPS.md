# 実装ステップ

設計書: [DESIGN.md](./DESIGN.md)

---

## Phase 0: プロジェクト基盤整備

### Step 0-1: モノリポ設定の更新

- [ ] `pnpm-workspace.yaml` を `packages/*` のみに整理（`apps/*` を削除）
- [ ] `.gitignore` に Rust / Pulumi / Wrangler 関連を追加

### Step 0-2: 環境変数テンプレート

- [ ] `.env.example` を作成（R2 / GCP の接続情報テンプレート）

---

## Phase 1: インフラ定義 (Pulumi)

### Step 1-1: Pulumi プロジェクト初期化

- [ ] `packages/infra/` ディレクトリに Pulumi TypeScript プロジェクトを作成
- [ ] `Pulumi.yaml`, `Pulumi.dev.yaml` を設定

### Step 1-2: R2 バケット

- [ ] Cloudflare R2 バケットをコードで定義
- [ ] API トークンを Pulumi secret で管理

### Step 1-3: Artifact Registry

- [ ] GCP Artifact Registry (Docker) リポジトリを定義

### Step 1-4: Cloud Run サービス

- [ ] Cloud Run サービスを定義（イメージは後で差し替え）
- [ ] 環境変数（R2 接続情報）を設定
- [ ] メモリ / CPU / 同時実行数を設定

---

## Phase 2: Cloud Run (Rust 画像変換サーバー)

### Step 2-1: Rust プロジェクト初期化

- [ ] `packages/image-processor/` に Cargo プロジェクトを作成
- [ ] 依存クレートを追加:
  - `axum` (Web フレームワーク)
  - `tokio` (非同期ランタイム)
  - `image` (画像デコード/エンコード)
  - `fast_image_resize` (高速リサイズ)
  - `aws-sdk-s3` (R2 アクセス)
  - `tower-http` (CORS, tracing)
  - `tracing` / `tracing-subscriber` (ログ)

### Step 2-2: R2 ストレージクライアント

- [ ] `storage.rs`: S3 互換クライアントで R2 からオブジェクト取得
- [ ] エンドポイント / 認証情報を環境変数から読み込み

### Step 2-3: 画像変換ロジック

- [ ] `transform.rs`: リサイズ処理 (`fast_image_resize`)
- [ ] `transform.rs`: フォーマット変換 (JPEG/PNG/WebP/AVIF)
- [ ] `transform.rs`: 品質調整
- [ ] `transform.rs`: メタデータ削除 (EXIF/XMP 等を常にストリップ)
- [ ] パラメータバリデーション（最大解像度, 品質範囲）

### Step 2-4: HTTP ハンドラ

- [ ] `handler.rs`: `GET /transform` — クエリパラメータをパースし変換実行
- [ ] `handler.rs`: `GET /health` — ヘルスチェック

### Step 2-5: Axum サーバー

- [ ] `main.rs`: ルーティング定義、サーバー起動
- [ ] graceful shutdown 対応

### Step 2-6: Dockerfile

- [ ] マルチステージビルド (`rust:1.84-slim` → `debian:bookworm-slim`)
- [ ] ローカルで `docker build` & `docker run` で動作確認

---

## Phase 3: Cloudflare Workers (エッジキャッシュ)

### Step 3-1: Workers プロジェクト初期化

- [ ] `packages/cdn/` に Hono + Workers プロジェクトを作成
- [ ] `wrangler.toml` を設定

### Step 3-2: キャッシュレイヤー

- [ ] `cache.ts`: Cache API ラッパー
  - `match()`: キャッシュからの取得
  - `put()`: キャッシュへの保存
  - クエリパラメータの正規化（ソート）

### Step 3-3: オリジンプロキシ

- [ ] `origin.ts`: Cloud Run への fetch
  - タイムアウト設定
  - エラーハンドリング（502/504）

### Step 3-4: ルーティング

- [ ] `index.ts`:
  - `GET /images/:key` — キャッシュチェック → オリジン → キャッシュ保存 → 返却
  - `PUT /images/:key` — R2 への直接アップロード（動作確認用、Workers → R2 binding）
  - `X-Cache: HIT/MISS` ヘッダ付与

### Step 3-5: R2 バインディング (アップロード用)

- [ ] `wrangler.toml` に R2 バインディングを追加
- [ ] PUT エンドポイントで R2 に直接書き込み

### Step 3-6: ローカル動作確認

- [ ] `wrangler dev` でローカル起動
- [ ] Cloud Run (ローカル Docker) と合わせて E2E 確認

---

## Phase 4: React クライアント (動作確認 UI)

### Step 4-1: Vite + React プロジェクト初期化

- [ ] `packages/client/` に Vite + React + TypeScript プロジェクトを作成

### Step 4-2: 画像アップロード

- [ ] ドラッグ&ドロップで画像を Workers PUT エンドポイントへアップロード

### Step 4-3: リサイズプレビュー

- [ ] w / h / f / q パラメータを UI で操作
- [ ] リアルタイムでリサイズ画像をプレビュー表示
- [ ] `X-Cache` ヘッダの表示（HIT / MISS）

---

## Phase 5: CD パイプライン (GitHub Actions)

### Step 5-1: CI ワークフロー

- [ ] `.github/workflows/ci.yml`:
  - PR / push でトリガー
  - Workers: lint / type-check
  - Rust: `cargo check` / `cargo clippy` / `cargo test`

### Step 5-2: Workers CD

- [ ] `.github/workflows/deploy-worker.yml`:
  - `main` push + `packages/cdn/**` パス変更でトリガー
  - `wrangler deploy` 実行
  - 必要 secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

### Step 5-3: Cloud Run CD

- [ ] `.github/workflows/deploy-cloud-run.yml`:
  - `main` push + `packages/image-processor/**` パス変更でトリガー
  - Docker build → Artifact Registry push → `gcloud run deploy`
  - 必要 secrets: `GCP_PROJECT_ID`, `GCP_SA_KEY`, `GCP_REGION`

---

## 実装順序の理由

```
Phase 0 (基盤)
    ↓
Phase 1 (インフラ) ← R2 バケットがないと画像保存できない
    ↓
Phase 2 (Rust) ← 画像変換の核。R2 にアクセスして変換するコア機能
    ↓
Phase 3 (Workers) ← Cloud Run が動いていないとオリジン転送できない
    ↓
Phase 4 (React) ← Workers が動いていないとプレビューできない
    ↓
Phase 5 (CD) ← 全コンポーネントが揃ってから自動化
```

各 Phase 完了時にローカル動作確認を行い、Phase 5 で CD を整備する。

---

## 見積もり（ファイル数）

| Phase | 新規ファイル数 | 主要ファイル |
|---|---|---|
| Phase 0 | 2 | workspace 設定 |
| Phase 1 | 6 | Pulumi 定義 |
| Phase 2 | 7 | Rust ソース + Dockerfile |
| Phase 3 | 6 | Workers ソース + wrangler.toml |
| Phase 4 | 5 | React ソース |
| Phase 5 | 3 | GitHub Actions workflows |
| **合計** | **29** | |
