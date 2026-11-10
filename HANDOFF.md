# 車、ちょっと借ります 引き継ぎ (2026-11-10)

## 目的
たろうが「何日の何時に親の車を使いたい」を申請 → 母が承認 / コメント。ログイン不要。LINEで通知。

## 構成
- 画面: `docs/` (GitHub Pages)。`docs/config.js` に WorkerのURLとLINE友だち追加URL。
- API: `worker/` (Cloudflare Worker + KV, 無料枠)。名前 `oya-kuruma`、URLは `https://oya-kuruma.ykdtm-home.workers.dev`。
- 本人確認: 専用リンク `…/oya-kuruma/#t=<トークン>`。トークンは2つ(TOKEN_SON, TOKEN_PARENT)。Workerのシークレット。
- 通知: LINE Messaging API の push。連携は画面の「LINE通知」→6桁コード→LINEトークで「連携 123456」。
  - Amazon定期便とは別チャンネル(別の公式アカウント)を使う。

## 機能(2026-11-10 承認制をやめて「否認+コメント」に変更)
- 申請はまず「下書き」(status=draft)に入る。母には見えず、LINEも飛ばない。画面上部の「まとめて送る」(POST /api/send)で全件が有効(active)になり、母にLINEが1通だけ届く。重なる分は送らず下書きに残す。送信後、母が問題あれば「否認」(理由コメント付き可)、あとで「否認を取り消す」も可。
- コメントは双方向、相手にLINE通知。
- 月カレンダー(○予定 / ▲母の予定 / ×否認)、日付タップでその日の予定。
- 母も自分の予定を入れられる。有効な予定・母の予定と重なる申請は不可(否認された枠は空き扱い)。
- 否認された申請を時間変更すると有効に戻り、母に通知。
- くり返し(毎週/隔週/毎月、終了日まで、最大60回): 登録時に1回ずつ独立した予定へ展開(同じ seriesId)。重なる日だけ除外して登録しLINEは1通にまとめる。1回ずつ変更・否認可。「この回以降をまとめて取り下げ」(DELETE ?scope=following)あり。母の予定もくり返し可。

## 更新方法
- `docs/` の変更: push だけ(数分で反映)。
- `worker/` の変更: PowerShell で `cd worker; git pull; npx wrangler deploy`。push前に `node test.mjs`。
- ローカル確認: `/tmp/devserver.mjs` 相当(KVをメモリで代用)で画面+Workerを動かして playwright で撮影。

## 状態
- コードとテストは完成。GitHubリポジトリ ykdtmnhnddsbba-jj/oya-kuruma は作成済み・push済み。KV作成・デプロイ・シークレット・LINEチャンネルは README の手順待ち(たろうのPCで実施)。
