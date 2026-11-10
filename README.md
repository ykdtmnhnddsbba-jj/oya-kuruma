# 親の車カレンダー セットアップ手順(コピペ用)

PowerShell は上から順に、ブロックごとにそのまま貼り付けて Enter。`<...>` の部分だけ自分で置き換える。

## 手順1: GitHub Pages を有効にする (ブラウザ)
https://github.com/ykdtmnhnddsbba-jj/oya-kuruma/settings/pages を開く。
- Source: `Deploy from a branch`
- Branch: `main` / フォルダ `/docs` → Save

数分後、画面が https://ykdtmnhnddsbba-jj.github.io/oya-kuruma/ で見られるようになる(この時点では「このリンクでは開けません」と出るのが正常)。

## 手順2: PCにダウンロード (PowerShell)
```powershell
cd C:\yutaro\App
git clone https://github.com/ykdtmnhnddsbba-jj/oya-kuruma
cd oya-kuruma\worker
```

## 手順3: データ置き場(KV)を作って設定ファイルに自動で書く (PowerShell)
```powershell
$out = npx wrangler kv namespace create KV 2>&1 | Out-String
$out
$id = [regex]::Match($out, '"id"\s*:\s*"([0-9a-f]{32})"').Groups[1].Value
"KV id = $id"
$utf8 = New-Object System.Text.UTF8Encoding $false
$toml = [IO.File]::ReadAllText("$PWD\wrangler.toml", $utf8) -replace 'REPLACE_WITH_KV_ID', $id
[IO.File]::WriteAllText("$PWD\wrangler.toml", $toml, $utf8)
Select-String -Path wrangler.toml -Pattern 'id ='
```
最後の行に `id = "<32文字>"` が出ればOK。`KV id = ` が空なら、上に出力された id を手で `wrangler.toml` の `REPLACE_WITH_KV_ID` と置き換える。

## 手順4: Worker を公開する (PowerShell)
```powershell
npx wrangler deploy
```
`https://oya-kuruma.ykdtm-home.workers.dev` と表示されればOK。

## 手順5: 専用リンクの合言葉(トークン)を作って登録する (PowerShell)
```powershell
function New-Token { $b = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b).TrimEnd('=').Replace('+','-').Replace('/','_') }
$tokSon = New-Token
$tokParent = New-Token
$tokSon | npx wrangler secret put TOKEN_SON
$tokParent | npx wrangler secret put TOKEN_PARENT
$base = "https://ykdtmnhnddsbba-jj.github.io/oya-kuruma/"
@("たろう用: $base#t=$tokSon", "お母さん用: $base#t=$tokParent") | Set-Content -Encoding utf8 .links.txt
Get-Content .links.txt
```
表示された2つのリンクが、それぞれの専用リンク。`worker\.links.txt` にも保存される(GitHubには上がらない。消さない)。

## 手順6: LINEチャンネルを作る (ブラウザ)
1. https://developers.line.biz/console/ を開き、Amazon定期便と同じプロバイダーを選ぶ。
2. 「新規チャネル作成」→「Messaging API」。チャネル名は「車カレンダー」など。
3. 作成後、「Messaging API設定」タブで次を設定:
   - Webhook URL: `https://oya-kuruma.ykdtm-home.workers.dev/api/line/webhook` → 更新 → 「検証」(SSLエラーなら数分待って再検証)
   - Webhookの利用: オン
   - 応答メッセージ: 「LINE Official Account Manager」のリンクから「オフ」にする
   - チャネルアクセストークン(長期): 「発行」を押してコピー
4. 「チャネル基本設定」タブの「チャネルシークレット」をコピー。

## 手順7: LINEの鍵を登録する (PowerShell)
実行すると入力待ちになるので、コピーした値を貼り付けて Enter。
```powershell
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_TOKEN
```

## 手順8: 友だち追加用URLを画面に入れる (PowerShell)
「Messaging API設定」タブの「ボットのベーシックID」(`@`から始まる文字)を使う。`@123abcde` なら下の `<ID>` を `@123abcde` に置き換える。
```powershell
cd C:\yutaro\App\oya-kuruma
$utf8 = New-Object System.Text.UTF8Encoding $false
$js = [IO.File]::ReadAllText("$PWD\docs\config.js", $utf8) -replace "LINE_ADD_URL: ''", "LINE_ADD_URL: 'https://line.me/R/ti/p/<ID>'"
[IO.File]::WriteAllText("$PWD\docs\config.js", $js, $utf8)
git add -A
git commit -m "LINE友だち追加URLとKV idを設定"
git push
```

## 手順9: 使い始める
1. `worker\.links.txt` の「たろう用」リンクを自分のスマホで、「お母さん用」リンクを母のiPhoneで開く(LINEで母に送ればOK)。
2. それぞれ右上「LINE通知」→ 友だち追加 → 出てきた数字を LINE に「連携 123456」と送る。
3. 「LINE通知」をもう一度開いて「テスト通知を送る」。届けば完了。
4. 母のiPhoneは、Safariで共有ボタン →「ホーム画面に追加」すると、アプリのように開ける。

## 使い方
- たろう: 「車を借りたい」で日時と行き先を入れると、母にLINEが届く。
- 母: 問題があれば申請の「否認する」を押す(コメント欄に理由を書くと一緒に伝わる)。コメントだけ送ることもできる。何もしなければ予定は有効のまま。
- 母も「車を使う予定を入れる」で自分の予定を入れられる。その時間には申請できなくなる。

## 更新するとき
- `docs/` の変更: push だけ。
- `worker/` の変更: `cd C:\yutaro\App\oya-kuruma\worker; git pull; npx wrangler deploy`
