<p align="center">
  <a href="./README.md"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
  <a href="./README.zh.md"><img src="https://img.shields.io/badge/lang-中文-red.svg" alt="中文"></a>
  <a href="./README.ja.md"><img src="https://img.shields.io/badge/lang-日本語-green.svg" alt="日本語"></a>
  <a href="./README.ko.md"><img src="https://img.shields.io/badge/lang-한국어-orange.svg" alt="한국어"></a>
</p>

# Codex HUD

> **注意:** この日本語版は 2026-08-04 時点の内容です。2026-08 以降の変更（回合失敗の表示、`/new` 検出、通知フック、配額予測、マウス操作、コンテンツに合わせたペイン高さなど）は英語版 [README.md](./README.md) と中国語版 [README.zh.md](./README.zh.md) のみに反映されています。

[OpenAI Codex CLI](https://github.com/openai/codex) 用のリアルタイムステータスバー HUD。軽量・設定不要・tmux 内で動作。

## Windows WSL サポート

Windows サポートは Ubuntu WSL 経由で `feature/windows-support-dual-entry` branch に用意されています。macOS/Linux では `main`、Windows (WSL) ではその feature branch を使用してください。

> Claude Code の [claude-hud](https://github.com/jarrodwatts/claude-hud) にインスパイアされています。

![Codex HUD — シングルセッション](./doc/fig/2a00eaf0-496a-4039-a0ce-87a9453df30d.png)

## なぜ Codex HUD が必要？

**Q: Codex CLI だけで十分では？**

計器なしのフライトと同じです。Codex HUD はターミナル下部に常駐ダッシュボードを表示します：

- **ブランチ・モデル・権限** —— 一目で把握、推測不要
- **Token 使用量（cache 含む）** —— コンテキストの消費量を正確に把握
- **Context ウィンドウ充填バー** —— 上限に近づいたら即座にわかる
- **MCP サーバー状況 & ツール呼び出し** —— Codex が実際に何をしているか監視
- **Reasoning effort レベル** —— 現在の思考深度を表示

**Q: 複数の Codex セッションを同時に監視できますか？**

はい。HUD ペインをクリックして `Ctrl+T` を押すか、メインペインで `codex-hud --toggle-mode` を実行すると、**マルチセッション概要モード**に切り替えられます。

![Codex HUD — マルチセッション概要](./doc/fig/6d0edbdd-19b5-4038-b9a3-ca5341fd39d1.png)

**Q: tmux を手動で設定する必要がありますか？**

不要です。Codex HUD は tmux を自動的に起動します。`codex` と入力するだけで HUD が表示されます。tmux 未インストールの場合もインストーラーが対応します。

## クイックスタート

### macOS/Linux（`main`）

```bash
git clone https://github.com/fwyc0573/codex-hud.git
cd codex-hud
git switch main
./bin/codex-hud-install

# シェルをリフレッシュして、以下を入力：
codex
```

### Windows (WSL)（`feature/windows-support-dual-entry`）

```powershell
git clone https://github.com/fwyc0573/codex-hud.git
cd codex-hud
git switch feature/windows-support-dual-entry
.\bin\codex-hud-install.ps1

# 新しい PowerShell または cmd ウィンドウを開いて確認：
codex --self-check

# WSL HUD で起動：
codex
```

### 管理コマンド

初回インストール後、以下のコマンドがシェルに追加されます：

| コマンド | 説明 |
|----------|------|
| `codex-hud-sync` | 現在のチェックアウトを再ビルドしエイリアスを更新 |
| `codex-hud-upgrade` | 現在の追跡ブランチを隔離ビルドし、成功後に fast-forward してエイリアスを更新 |
| `codex-hud-uninstall` | エイリアスを削除し HUD セッションを停止 |

## HUD に何が表示される？

```
[gpt-5.4 xhigh] █████░░░░ 45% │ my-project git:(main ●) │ 12m
3 extensions | 5 skills | 2 hooks | 2 AGENTS.md | Approval: ask for approval | Fast: on | Sandbox: ws-write
Ctx: ████░░░░ 45% (50.2K/128K) | Tokens: 50.2K | (in: 35.0K, cache: 5.0K, out: 15.2K) | ↻2
Dir: ~/my-project | Session: abc12345 | CLI: 0.4.2
◐ exec_command: npm test @my-project 1.4s | ✗ exec_command: rg … 48ms exit 1
◐ codex_cli_explore 2m14s ↳2
```

| 行 | 内容 |
|----|------|
| **ヘッダー** | モデル + effort、context バー、プロジェクト名、git ブランチ、セッションタイマー |
| **環境** | 設定/MCP/skill/hook 数、命令ファイル、実行時の承認/サンドボックス、Fast モード |
| **Tokens** | 合計 token（入力/cache/出力の内訳）、context 充填率、compact 回数 |
| **Session** | 作業ディレクトリ、Session ID、CLI バージョン。plan と完了済み tool 履歴より先に表示 |
| **アクティビティ** | サニタイズ済みの実行中ツール詳細、所要時間/終了コードまたはバックグラウンド session の結果、最近のツール履歴、アクティブな subagent |

ツール activity はデフォルトで物理 1 行に収まります。コマンドと patch 対象は表示前にサニタイズおよび長さ制限され、raw stdout/stderr と raw ツール引数は保持も表示もしません。

HUD pane のデフォルト高さはターミナル高の 6 分の 1（5–12 行）で、狭い pane では最大 3 行追加されます。`CODEX_HUD_HEIGHT` を明示すると固定高になり、`CODEX_HUD_HEIGHT_AUTO=1` も設定した場合のみ幅に応じて調整されます。既存 Session は次回の attach または `codex-hud --reload` で新しい設定を採用します。表示が pane 高を超える場合は `+N hidden` を表示します。

### Subagent activity

展開モードでは、可視の直接子ごとに icon-first の行を 1 行表示します。例：`◐ codex_cli_explore 2m14s ↳2`。名前には typed agent path の末尾を使い、`↳N` は全階層にある可視のアクティブな子孫数です。turn が完了または abort すると即座に消えますが、アクティブな子孫が残る場合は直接子の集約行を維持します。authoritative な rollout または metadata の追跡に失敗した場合は `✗ <name> tracking error` を表示し、回復するまで同じ typed child path のみを再試行します。

コンパクトモードでは `Agents: N` を表示します。`N` は展開モードの直接子行数ではなく、root が所有するツリー全体の可視 agent node 数です。マルチセッション概要では、所有元の root session に activity が集約されるため、typed subagent session を除外します。

`CODEX_HUD_AGENT_INACTIVITY_TIMEOUT_MS` は running turn の非アクティブ時間を制御します。デフォルトは `900000` ms（15 分）で、ミリ秒単位の正の safe integer のみ受け付けます。空、無効、ゼロ、負数、小数、unsafe integer は起動時にエラーになります。この timeout は古い表示を隠すだけで、agent を中断せず、hung や crash を証明できません。`starting` と `tracking error` は timeout しません。

## 使い方

```bash
codex                        # HUD 付きで起動
codex --model gpt-5          # Codex CLI 引数を渡す
codex "help me debug this"   # プロンプト付き
cx                           # codex の短いエイリアス
codex-resume                 # 前回のセッションを再開
```

<details>
<summary>その他のコマンド</summary>

```bash
codex-hud --kill             # 現在のディレクトリのセッションを終了
codex-hud --list             # すべての HUD セッションを一覧表示
codex-hud --attach           # 既存セッションにアタッチ
codex-hud --new-session      # 新規セッションを強制作成
codex-hud --self-check       # 環境診断を実行
```

</details>

## 設定

### 環境変数

| 変数 | デフォルト | 説明 |
|------|------------|------|
| `CODEX_HUD_POSITION` | `bottom` | HUD ペインの位置（`top` / `bottom`） |
| `CODEX_HUD_HEIGHT` | 自動 `5–12` | ターミナル高の 6 分の 1、または明示した固定行数 |
| `CODEX_HUD_MOUSE` | `1` | マウス/トラックパッドスクロールを有効化 |

<details>
<summary>すべての環境変数</summary>

| 変数 | デフォルト | 説明 |
|------|------------|------|
| `CODEX_HUD_HEIGHT_AUTO` | 自動高：`1`、明示高：`0` | 狭い pane で最大 3 行追加 |
| `CODEX_HUD_HEIGHT_MIN` | 自動：`5`、明示高：`CODEX_HUD_HEIGHT` | 自動モードの最小高さ |
| `CODEX_HUD_HEIGHT_MAX` | `12` | 自動モードの最大高さ |
| `CODEX_HUD_AUTO_ATTACH` | `0` | 同ディレクトリの最新セッションに自動アタッチ |
| `CODEX_HUD_ALTERNATE_SCREEN` | `0` | codex ペインの tmux alternate-screen |
| `CODEX_HUD_BIND_TOGGLE` | `0` | tmux server 全体の `Prefix+H` HUD 切替を有効化 |
| `CODEX_HUD_CLEAR_SCROLLBACK` | `0` | 初回レンダリング時にスクロールバックをクリア |
| `CODEX_HUD_AGENT_INACTIVITY_TIMEOUT_MS` | `900000` | running agent の表示 timeout。正の safe integer ミリ秒値のみ |
| `CODEX_HUD_CWD` | （未設定） | 作業ディレクトリを上書き |
| `CODEX_HOME` | `~/.codex` | Codex ホームディレクトリ |
| `CODEX_SESSIONS_PATH` | （未設定） | sessions ディレクトリを上書き |

</details>

### config.toml

HUD は `CODEX_HOME/config.toml` から設定を読み取ります：

```toml
model = "gpt-5.2-codex"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[mcp_servers.my-server]
command = ["node", "server.js"]
enabled = true
```

## 対応システム

| プラットフォーム | 状態 |
|------------------|------|
| Linux | 対応済み |
| macOS (Apple Silicon) | 対応済み |
| macOS (Intel) | テスト待ち |
| Windows (WSL) | `feature/windows-support-dual-entry` で対応済み |

## 開発

```bash
npm install && npm run build   # ビルド
npm run dev                    # ウォッチモード
node dist/index.js             # HUD を直接実行
```

## 変更履歴

| 日付 | 変更内容 |
|------|----------|
| 2026-08-04 | targets モードで実行コマンドのヘッド表示、parse-queue/不正行フリーズ修正、chokidar 5 watcher 修復、セッションプローブ非同期化、OSC 8 ハイパーリンク |
| 2026-07-12 | authoritative な subagent activity、timeout の意味、概要フィルタリングを文書化 |
| 2026-04-09 | クイックインストール/同期/アップグレード/アンインストールコマンドを追加 |
| 2026-04-09 | HUD セッションを tmux ペインにバインド、reasoning effort を表示 |
| 2026-02-09 | リサイズ後のメインペインフォーカス修正、マウススクロールのデフォルト改善 |
| 2026-02-09 | セッションアタッチのデフォルトとスクロールバック設定を更新 |

## ライセンス

MIT

## クレジット

Jarrod Watts の [claude-hud](https://github.com/jarrodwatts/claude-hud) にインスパイアされています。[OpenAI Codex CLI](https://github.com/openai/codex) 用に構築。
