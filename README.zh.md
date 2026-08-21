<p align="center">
  <a href="./README.md"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
  <a href="./README.zh.md"><img src="https://img.shields.io/badge/lang-中文-red.svg" alt="中文"></a>
  <a href="./README.ja.md"><img src="https://img.shields.io/badge/lang-日本語-green.svg" alt="日本語"></a>
  <a href="./README.ko.md"><img src="https://img.shields.io/badge/lang-한국어-orange.svg" alt="한국어"></a>
</p>

# Codex HUD

[OpenAI Codex CLI](https://github.com/openai/codex) 的实时状态栏 HUD。轻量、零配置、在 tmux 中运行。

## Windows WSL 支持

Windows 支持已在 `feature/windows-support-dual-entry` branch 通过 Ubuntu WSL 提供。macOS/Linux 用户使用 `main`；Windows (WSL) 用户使用该 feature branch。

> 灵感来源于 Claude Code 的 [claude-hud](https://github.com/jarrodwatts/claude-hud)。

![Codex HUD — 单 Session 模式](./doc/fig/2a00eaf0-496a-4039-a0ce-87a9453df30d.png)

## 为什么需要 Codex HUD？

**Q: Codex CLI 本身就能用，为什么还需要 HUD？**

因为没有它你就是在盲飞。Codex HUD 在终端底部提供一个持久的仪表盘：

- **分支、模型、权限** —— 一目了然，不用猜
- **Token 用量（含 cache）与 Context 剩余量** —— 快撞墙时提前知道
- **当前 turn、工具、计划与 subagent 状态** —— 看 Codex 实际在干什么
- **限流与采集健康告警** —— 区分“没有数据”和“数据已陈旧/解析异常”
- **权限、Sandbox、Fast、MCP 与 Codex skill** —— 高风险状态优先显示
- **Reasoning effort 级别** —— 当前思考深度一目了然

**Q: 我同时跑多个 Codex session，能一起监控吗？**

可以。先点击 HUD pane，再按 `Ctrl+T`；也可以在主 pane 执行
`codex-hud --toggle-mode`；设置 `CODEX_HUD_BIND_TOGGLE=1` 会安装 `Prefix+H`
键位，无需切换焦点即可使用，提示行会显示当前会话实际拥有的那一种。概览列出最近
30 分钟内有活动的 session——不只是恰好正在执行回合的那些——先按当前阶段排序，再按
最近活动时间排序，Context 剩余量作为并列时的次序。概览用 `▸` 标出当前 HUD 绑定的
session，并保证该行在 session 数超过可显示行数时仍然可见。各 HUD 在自己主 pane 上
确认到的状态——等待审批、被 stream error 打断的回合、Codex 已退出——会随其发布的绑定
一起传播，所以任何一块面板上都显示 `Approval`/`Interrupted`/`Exited`，而不是陈旧的
`Thinking` 或 `Idle`；已退出的 session 排在空闲的之后。每行末尾是承载它的 tmux
session 名——即 `tmux ls` 和 session 选择器里显示的那个名字，所以看到需要处理的行就
能直接定位；仅由 rollout 扫描发现、没有 HUD pane 的 session 回退显示 Session ID。
只有列出的 session 使用了不同模型时才会出现模型列。账号配额窗口列在 session 之后
——它是唯一对所有行同时成立的数字；只有用量高到构成告警时，它才会占用一行 session
列表。扫描在进入该模式时才发起，因此当前 HUD 绑定的 session 会立即列出，其余稍后
补齐。HUD pane 处于焦点时，按 `t` 可循环切换工具详情级别（`targets` → `full` →
`off`），并短暂显示切换后的级别。

![Codex HUD — 多 Session 概览](./doc/fig/6d0edbdd-19b5-4038-b9a3-ca5341fd39d1.png)

**Q: 需要手动配置 tmux 吗？**

不需要。Codex HUD 自动激活 tmux。只需输入 `codex`，HUD 就会出现。如果没装 tmux，安装程序也会搞定。

## 快速开始

### macOS/Linux（`main`）

```bash
git clone https://github.com/fwyc0573/codex-hud.git
cd codex-hud
git switch main
./bin/codex-hud-install

# 刷新 shell，然后直接输入：
codex
```

### Windows (WSL)（`feature/windows-support-dual-entry`）

```powershell
git clone https://github.com/fwyc0573/codex-hud.git
cd codex-hud
git switch feature/windows-support-dual-entry
.\bin\codex-hud-install.ps1

# 打开新的 PowerShell 或 cmd 窗口，然后检查：
codex --self-check

# 使用 WSL HUD 启动：
codex
```

### 管理命令

首次安装后，以下命令自动加入 shell：

| 命令 | 说明 |
|------|------|
| `codex-hud-sync` | 重新构建并刷新当前 checkout 的别名 |
| `codex-hud-upgrade` | 隔离构建当前跟踪分支的更新，通过后再快进并刷新别名 |
| `codex-hud-uninstall` | 移除别名并停止 HUD 会话 |
| `codex-hud --doctor` | 检查 Codex、Node、tmux、构建产物和 alias，并打印最近的 HUD 诊断日志 |
| `codex-hud --kill` | 终止当前目录最新的会话（`--all`：本目录全部会话） |
| `codex-hud --reload` | 必要时先重建，再重启当前目录最新会话的 HUD pane |
| `codex-hud --reload --all` | 同上，但重启当前目录所有会话的 HUD pane |
| `codex-hud --toggle-mode` | 不切换焦点，切换单 Session/概览模式 |
| `codex-hud --list` | 列出所有 codex-hud session，附带工作目录、attach 状态，以及 HUD pane 是否还活着——HUD 进程比磁盘上的构建更旧时标注 `HUD: outdated` |
| `codex-hud --hud-version` | 显示包版本和 checkout revision |

## HUD 显示了什么？

```text
[gpt-5.6-sol high] my-project git:(main *) up 12m
[FULL ACCESS] | Fast: on | MCP configured: 3 | Codex skills: 5
Ctx: ███████░░░░░ 55% left (70.4K) | Tokens: 50.2K | (in: 30.0K, cache: 5.0K, out: 15.2K) | Total: 1.2M
◐ Thinking 42s · event 8s ago
◐ exec_command: npm test @my-project 1.4s | ✓ read_file ×3
```

上下文进度条是"油量表"语义：实心格表示剩余量，与旁边的 `% left` 文字一致；颜色反映压力（绿 → 黄 → 红）。`Total` 是本 session 的累计 token 消耗，与单轮用量并列。

尚未绑定 Codex session 时，HUD 显示 `○ Waiting for a Codex session…`，而不是渲染一个可能被误认为故障的半截画面。

| 行 | 内容 |
|----|------|
| **标题** | 模型 + effort、项目名、git 分支，以及绑定的 Codex 会话已运行多久。首轮采集完成前模型显示为 `[…]`、不显示时长，因为此时两者都还不知道 |
| **安全与环境** | `[FULL ACCESS]`、审批/Sandbox/Fast 优先（徽章已蕴含的单元不再重复显示，默认态 `Fast: off` 弱化为 dim）；随后是 MCP、Codex skill、hook、AGENTS.md 和配置来源 |
| **容量** | Context 剩余百分比/剩余 token、输入/cache/输出拆分、累计消耗、compact 次数；只要版面还有空行就显示限额窗口及其 reset 时刻，使用率达到 70% 后转为高亮告警；reset 时刻已过的限额快照直接不显示，不再重放。限额是账号级状态，取本机任一 Codex 会话写下的、**确实报出了读数的**最新快照，而不是绑定会话碰巧最后看到的那一份——窗口耗尽后 Codex 会写出不含任何窗口的快照，直接取最新的那份会让配额行在 100% 时反而消失。若快照没有任何窗口但信用额度为空，则显示 `credits: 0`；处于这种耗尽期时，扫描会继续向更旧的文件走，直到找到仍然写明 reset 时刻的读数，而不是数满固定文件数就停。reset 距今不足一天时改为倒计时（`resets in 2h13m`）；窗口用掉一半之后，两份带时间戳的读数即可算出燃速，若按此速率会在 reset 之前耗尽，则在行上标出（`→ empty ~08/22`） |
| **健康** | Git、会话日志、agent、项目扫描、配置、概览采集以及 HUD 自身显示的状态（自然语言描述），以及本版本无法识别的 Codex 记录条数。尚未完成首轮的采集器保持沉默，只有跑过又停了才算告警。HUD 运行期间 `dist/` 被重新构建时，这里会出现一条暗色的 `HUD updated on disk · codex-hud --reload`——pane 里跑的永远是它启动那一刻的构建 |
| **活动** | Thinking/Running tool/Responding/Idle、工具耗时/结果、计划进度和活跃 subagent；空闲会话还会显示上一轮耗时。命令非零退出会标记为 `✗` 并显示退出码——包括 Codex 把它放在一段自身执行成功的脚本里运行的情况。stream error 只画在 Codex TUI 上、不写入会话日志，被它打断的回合会永远停在 `Thinking`；静默数分钟后 HUD 会去主 pane 查错误横幅，只有确认存在才显示 `✗ Turn likely interrupted`。Codex 自身退出（quit、崩溃或拒绝信任提示）时，wrapper 会把 pane 交还给你的 shell，而磁盘上没有任何记录说明这件事；对安静的会话，HUD 会探测主 pane 进程树里是否还有活着的 Codex（Codex 以孙进程形态运行，tmux 自己的 pane 命令始终显示为 shell），没有则显示 `○ Codex exited · run codex to restart`，不再假装在等待一个没人会输入的回合 |
| **Session** | 工作目录、Session ID、CLI 版本；排在计划和工具历史之后，小 pane 优先保留动态信息。Session ID 在行宽允许时完整显示——`codex resume`、`fork`、`archive`、`delete` 接受的正是它；pane 更窄时才回退为缩写形式 |

版面是双向自适应的。有余量时会同时保留回合行与运行中工具行，因为两者计的不是同一个数：回合行是 Codex 连续执行工具的时长，工具行是当前这一条调用的时长。pane 放不下时按顺序整行舍弃低信号内容——先是低压限额读数，然后回合行，然后 Session 详情行，然后多条 agent 行折叠成一行 `◐ N agents` 计数，最后才是静态环境行（其 `[FULL ACCESS]` 徽章上移到标题行）——保证计划和 agent 等动态状态存活，而不是截断时恰好落在末尾的内容被丢弃。

窄 pane 上按"整个单元"舍弃，而不是把词截断。标题行保住项目名、收缩分支名；环境行取其优先级序列中能放下的最长前缀——权限在前、清单计数在后——实在放不下就整行让出，而不是显示半句安全状态。因为取的是前缀而不是能塞就塞，把 pane 拖宽只会增加单元，短的低优先单元也不会再占掉高优先单元的位置。

工具活动默认仍只占一行。默认 `CODEX_HUD_TOOL_DETAILS=targets`：执行类工具只显示保护隐私的**命令头部**——程序名加一个已知子命令或脚本名（如 `npm test`、`sed && rg`），不含任何参数、路径或标志；文件类工具只显示脱敏后的目标。`full` 才显示已脱敏、限长后的完整命令摘要，`off` 完全隐藏工具行。原始 stdout/stderr 和原始工具参数不会被保留或显示。

Codex CLI 0.147 把所有工具收敛到单个 `exec` 工具，其参数是一段 JavaScript 程序而
非 JSON，命令的退出状态也只写在另一条独立记录里。HUD 同时读取这两处，因此命令、
工作目录、被改文件名、计划步骤和非零退出在新旧两种形态下都能还原。

HUD 会按终端单元格宽度处理中文、emoji、组合字符和 ANSI。默认 pane 高度取终端高度的六分之一，并限制在 5–12 行；窄终端最多再增加 3 行。显式设置 `CODEX_HUD_HEIGHT` 时保持固定，除非同时设置 `CODEX_HUD_HEIGHT_AUTO=1`。已有 Session 会在下次 attach 或执行 `codex-hud --reload` 时采用新策略。输出不会超过 pane 高度；信息过多时最后一行显示 `+N hidden`。设置 `NO_COLOR=1` 或 `TERM=dumb` 可禁用颜色，`CODEX_HUD_ASCII=1` 可使用 ASCII 状态符号。

### Subagent 活动

展开模式为每个可见的直接子节点显示一行 icon-first 状态，例如 `◐ codex_cli_explore 2m14s ↳2`。名称取自 typed agent path 的最后一段；`↳N` 表示任意深度下可见的活跃后代数量。turn 完成或 abort 后会立即消失；只有仍有活跃后代时，直接子节点的聚合行才会继续保留。权威 rollout 或 metadata 跟踪失败会显示为 `✗ <name> tracking error`，并持续重试同一条 typed child path，直到恢复（重试间隔从 1s 退避到最多 10s）。

紧凑模式显示 `Agents: N`；`N` 统计 root 所拥有整棵树中的所有可见 agent 节点，而不只是展开模式中的直接子节点行。多 Session 概览会排除 typed subagent session，因为它们的活动已经归入所属 root session。

`CODEX_HUD_AGENT_INACTIVITY_TIMEOUT_MS` 控制 running turn 的不活跃窗口。默认值为 `900000` ms（15 分钟），只接受以毫秒表示的正 safe integer；空值、无效值、零、负数、小数或 unsafe integer 会在启动时直接报错。timeout 只隐藏陈旧的界面显示，不会中断 agent，也不能证明 agent 已卡死或 crash。`starting` 和 `tracking error` 不受该 timeout 影响。

## 使用方法

```bash
codex                        # 启动并自动显示 HUD
codex --model gpt-5          # 传递 Codex CLI 参数
codex "help me debug this"   # 带初始提示
cx                           # codex 的短别名
codex-resume                 # 恢复上次会话
```

不带 Codex CLI 参数运行 `codex` 时，如果同目录已有 HUD tmux 会话，会自动重连到
最新会话。需要强制新开会话时使用 `codex-hud --new-session`。

安装会把 `codex` 指向本 wrapper，因此它必须区分哪些命令值得托管：提示词、交互式
参数、`resume`、`fork` 会启动带 HUD 的会话；不开启会话的 Codex 子命令——`exec`、
`login`、`mcp`、`completion`、`apply`、`doctor`、`update`、`--version` 等——就地
执行并保留自己的 stdout，所以 `codex exec "…" | jq`、
`codex completion zsh >> ~/.zshrc` 的行为与不装 wrapper 时一致。`codex help` 是
Codex CLI 自己的帮助，`codex-hud --help` 是本 wrapper 的帮助。

<details>
<summary>更多命令</summary>

```bash
codex-hud --kill             # 终止当前目录最新的会话（--all：全部）
codex-hud --list             # 列出所有 HUD 会话
codex-hud --attach           # 复用已有会话
codex-hud --new-session      # 强制新建会话
codex-hud --doctor           # 运行环境诊断（--self-check 的别名）
codex-hud --reload           # 重启当前目录最新会话的 HUD pane
codex-hud --reload --all     # 重启当前目录所有会话的 HUD pane
codex-hud --toggle-mode      # 切换单 Session/概览模式
codex-hud --hud-version      # 显示版本与 revision
```

</details>

## 配置

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CODEX_HUD_POSITION` | `bottom` | HUD 面板位置（`top` / `bottom`） |
| `CODEX_HUD_HEIGHT` | 自适应 `5–12` | 默认取终端高度的六分之一，也可显式指定固定行数 |
| `CODEX_HUD_MOUSE` | `1` | 启用鼠标/触控板滚动 |
| `CODEX_HUD_TOOL_DETAILS` | `targets` | 工具详情：`off` / `targets` / `full` |

<details>
<summary>全部环境变量</summary>

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CODEX_HUD_HEIGHT_AUTO` | 自适应高度：`1`；显式高度：`0` | 窄 pane 最多额外增加 3 行 |
| `CODEX_HUD_HEIGHT_MIN` | 自适应：`5`；显式高度：`CODEX_HUD_HEIGHT` | 自动模式最小高度 |
| `CODEX_HUD_HEIGHT_MAX` | `12` | 自动模式最大高度 |
| `CODEX_HUD_AUTO_ATTACH` | `0` | 即使传入 Codex CLI 参数也自动复用会话 |
| `CODEX_HUD_ALTERNATE_SCREEN` | `0` | codex pane 的 tmux alternate-screen |
| `CODEX_HUD_BIND_TOGGLE` | `0` | 安装作用于整个 tmux server 的 `Prefix+H` HUD 切换键 |
| `CODEX_HUD_CLEAR_SCROLLBACK` | `0` | 首次渲染时清理 scrollback |
| `CODEX_HUD_HISTORY_LIMIT` | `10000` | 仅 HUD pane 使用的 scrollback 行数；主 pane 保留继承值 |
| `CODEX_HUD_TOOL_DETAILS` | `targets` | 执行类默认显示命令头部（如 `npm test`）；`full` 显示脱敏摘要，`off` 隐藏工具行（运行时可按 `t` 循环切换） |
| `CODEX_HUD_MODE` | `single` | 初始显示模式：`single` 或 `overview` |
| `CODEX_HUD_LOG_FILE` | 每用户默认路径 | 将 HUD 诊断信息（watcher/渲染/追踪错误）追加写入该文件。macOS 默认 `~/Library/Logs/codex-hud/hud.log`，其他平台为 `$XDG_STATE_HOME/codex-hud/hud.log`；设为 `off` 则丢弃 |
| `CODEX_HUD_NO_ATTACH` | `0` | 已废弃：强制新建会话而不复用 |
| `CODEX_HUD_SHOW_OTHER_AGENT_SKILLS` | `0` | 额外显示 `.agents` 的 skill 数；Codex skill 权威目录仍是 `CODEX_HOME/skills` |
| `CODEX_HUD_NOTIFY_CMD` | （未设置） | 会话进入需要人来处理的状态时执行的 shell 命令：等待审批、回合被打断、撞上限额（`approval-needed` / `turn-interrupted` / `limit-reached`）。事件 JSON 通过 stdin 与 `CODEX_HUD_EVENT_JSON` 传入，事件名单独放在 `CODEX_HUD_EVENT`。只在状态跃迁时触发——启动或换绑后的首次观察只记基线不通知，抖动的状态每五分钟至多通知一次。示例：`CODEX_HUD_NOTIFY_CMD='osascript -e "display notification \"$CODEX_HUD_EVENT\" with title \"codex-hud\""'` |
| `CODEX_HUD_ASCII` | `0` | 使用 ASCII 进度条和状态符号 |
| `NO_COLOR` | （未设置） | 设置任意值后禁用 ANSI 颜色 |
| `CODEX_HUD_AGENT_INACTIVITY_TIMEOUT_MS` | `900000` | running agent 的界面 timeout；只接受正 safe integer 毫秒值 |
| `CODEX_HUD_CWD` | （未设置） | 覆盖工作目录 |
| `CODEX_HOME` | `~/.codex` | Codex home 目录 |
| `CODEX_SESSIONS_PATH` | （未设置） | 覆盖 sessions 目录 |

`CODEX_HUD_SESSION_START`、`CODEX_HUD_MAIN_PANE`、`CODEX_HUD_TMUX_SESSION`
属于 wrapper→HUD 的内部传参，不建议手动设置。

</details>

### config.toml

HUD 从 `CODEX_HOME/config.toml` 读取配置：

```toml
model = "gpt-5.2-codex"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[mcp_servers.my-server]
command = ["node", "server.js"]
enabled = true
```

## 系统支持

运行时要求 Node.js `>=20.19.0`（与 Chokidar 5 的 engine 契约一致）和 tmux。推荐 Node.js `>=22.5`：会话绑定将使用内置 `node:sqlite`，无需额外安装 `sqlite3` CLI（20.x 上需要单独安装）。

| 平台 | 状态 |
|------|------|
| Linux | 已支持 |
| macOS (Apple Silicon) | 已支持 |
| macOS (Intel) | 待测试 |
| Windows (WSL) | 已在 `feature/windows-support-dual-entry` 支持 |

## 开发

```bash
npm install                    # 安装依赖
npm run typecheck              # 仅类型检查
npm run test:unit              # 构建并运行单元测试
npm run test:integration       # 构建并运行隔离集成测试
npm test                       # 类型检查 + 构建 + 全部测试
npm run test:render            # 运行渲染示例
```

## 更新日志

| 日期 | 变更 |
|------|------|
| 2026-08-04 | targets 模式显示执行命令头部、parse-queue/坏行永久冻结修复、chokidar 5 watcher 修复（跨午夜安全）、会话探测异步化、tracking-error 退避、OSC 8 超链接、概览列对齐 |
| 2026-07-30 | 增量协议解析、异步采集缓存、健康/限流/turn 状态、Unicode 宽度、隐私和 HUD 控制命令 |
| 2026-07-12 | 记录权威 subagent 活动、timeout 语义与概览过滤行为 |
| 2026-04-09 | 新增快速安装/同步/升级/卸载命令 |
| 2026-04-09 | HUD 按 tmux pane 绑定会话；显示 reasoning effort |
| 2026-02-09 | 修复 resize 后主 pane 焦点漂移；优化鼠标滚动默认行为 |
| 2026-02-09 | 更新会话复用默认策略与滚动配置 |

## 许可证

MIT

## 致谢

灵感来源于 Jarrod Watts 的 [claude-hud](https://github.com/jarrodwatts/claude-hud)。为 [OpenAI Codex CLI](https://github.com/openai/codex) 构建。
