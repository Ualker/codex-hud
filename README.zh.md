<p align="center">
  <a href="./README.md"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
  <a href="./README.zh.md"><img src="https://img.shields.io/badge/lang-中文-red.svg" alt="中文"></a>
  <a href="./README.ja.md"><img src="https://img.shields.io/badge/lang-日本語-green.svg" alt="日本語"></a>
  <a href="./README.ko.md"><img src="https://img.shields.io/badge/lang-한국어-orange.svg" alt="한국어"></a>
</p>

# Codex HUD

[OpenAI Codex CLI](https://github.com/openai/codex) 的实时状态栏 HUD。轻量、零配置、在 tmux 中运行。

> 灵感来源于 Claude Code 的 [claude-hud](https://github.com/jarrodwatts/claude-hud)。

![Codex HUD — 单 Session 模式](./doc/fig/single.svg)

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

可以。点击 HUD 中的 `[view]` 按钮，或在主 pane 执行 `codex-hud --toggle-mode`；`Prefix+H`
也能在 Codex pane 里直接切换——只要这个键没被占用，wrapper 就会安装它
（`CODEX_HUD_BIND_TOGGLE=0` 跳过，`1` 强制），提示行会显示当前会话实际拥有的那一种。
HUD 自己接收鼠标事件；滚轮不改变详情级别，也不会进入 tmux copy-mode 让画面冻结。概览列出最近
30 分钟内有活动的 session——不只是恰好正在执行回合的那些——先按当前阶段排序，再按
最近活动时间排序，Context 剩余量作为并列时的次序。概览用 `▸` 标出当前 HUD 绑定的
session，并保证该行在 session 数超过可显示行数时仍然可见。各 HUD 在自己主 pane 上
确认到的状态——等待审批、被 stream error 打断的回合、Codex 已退出——会随其发布的绑定
一起传播，所以任何一块面板上都显示 `Approval`/`Interrupted`/`Exited`，而不是陈旧的
`Thinking` 或 `Idle`；已退出的 session 排在空闲的之后。确认到的 `/new` 新会话提示符
也同样传播：该行显示 `New prompt`，而不是上一个会话的空闲状态。每行末尾是承载它的 tmux
session 名——即 `tmux ls` 和 session 选择器里显示的那个名字，所以看到需要处理的行就
能直接定位；仅由 rollout 扫描发现、没有 HUD pane 的 session 回退显示 Session ID。
只有列出的 session 使用了不同模型时才会出现模型列；宽度允许时还有一列标题——会话的
首条提示词，也就是 `codex resume` 列表里用的那个标签——因为同一项目开两个 session 时，
两行此前只差一段不透明 tmux 名的尾巴；单视图第 1 行也显示同一个标题。账号配额窗口列在 session 之后
——它是唯一对所有行同时成立的数字；只有用量高到构成告警时，它才会占用一行 session
列表。扫描在进入该模式时才发起，因此当前 HUD 绑定的 session 会立即列出，其余稍后
补齐。聚焦 HUD 后按 `t`，或在主 pane 执行 `codex-hud --cycle-details`，可循环切换工具详情（`targets` → `full` → `off`）。按 `d` 独立切换 HUD 简洁/完整详情。

![Codex HUD — 多 Session 概览](./doc/fig/overview.svg)

**Q: 需要手动配置 tmux 吗？**

不需要。Codex HUD 自动激活 tmux。只需输入 `codex`，HUD 就会出现。如果没装 tmux，安装程序也会搞定。

默认布局保留上下文余量、compact 次数、额度、当前活动，以及需要人工处理的审批/失败/中断状态。完整 token 明细、会话 ID、环境清单和历史工具记录由 `d` 展开，也可用 `CODEX_HUD_DETAILS=full` 设置初始模式。`Last call` 对应单次模型请求，`Total` 表示会话累计用量；`t` 只改变工具命令详情，不影响其他信息。多个工具并发时显示完整运行数量，历史列表裁剪不会丢掉仍在运行的调用。

控制命令优先选择当前 tmux pane 所属会话；在 tmux 外仅自动选择当前目录的唯一候选，多个候选时列出列表并要求 `--target 完整会话名` 或 `--target %pane编号`。`--all` 只适用于 `--kill` / `--reload`，作用于当前目录。点击正文仅聚焦，不再切换视图；切换使用可见的 `[view]` 按钮或已有快捷键。

概览窄窗优先保留地址、状态和上下文数值，再分配标题、进度条等可选列。扫描失败保留上次成功结果并显示警告；无法读取的会话保留身份、标记 `Unknown`。失效或已关闭的 HUD pane 不再作为在线绑定。配额快照和燃速基线按真实 `CODEX_HOME` 与 sessions 目录隔离共享，升级后的首次读取会建立新基线。

## 快速开始

### macOS/Linux（本仓库）

```bash
git clone --branch integrate/upstream-main-20260714 https://github.com/Ualker/codex-hud.git
cd codex-hud
./bin/codex-hud-install

# 刷新 shell，然后直接输入：
codex
```

本仓库的 macOS/Linux 功能以 `integrate/upstream-main-20260714` 为维护分支；需要容器轮询兼容时使用 `74server`，该分支保留 `CHOKIDAR_USEPOLLING=1` 监听策略。Windows/WSL 属于上游的独立分支，不作为本 fork 的已验证安装入口。

已有 checkout：`codex-hud-upgrade` 更新当前跟踪分支；`codex-hud-sync` 只构建当前源码并刷新别名。安装/同步会保留 shell 配置的符号链接、文件权限与托管段后面的用户覆盖，重复执行不会累积空行。构建完成后，用 `codex-hud --reload --target 完整会话名` 重启指定 HUD；同目录全部 HUD 使用 `--reload --all`。重启会检查 HUD Node 进程是否启动并保持存活，任何失败（含部分失败）均返回非零；主 Codex pane 保留。

### 管理命令

首次安装后，以下命令自动加入 shell：

| 命令 | 说明 |
|------|------|
| `codex-hud-sync` | 重新构建并刷新当前 checkout 的别名 |
| `codex-hud-upgrade` | 隔离构建当前跟踪分支的更新，通过后再快进并刷新别名 |
| `codex-hud-uninstall` | 移除别名并停止 HUD 会话 |
| `codex-hud --doctor` | 检查 Codex、Node、tmux、构建产物和 alias，并打印最近的 HUD 诊断日志 |
| `codex-hud --kill` | 终止当前/唯一会话（`--all`：本目录全部会话） |
| `codex-hud --reload` | 必要时先重建，再重启当前/唯一会话的 HUD pane；支持 `--target` 明确指定 |
| `codex-hud --reload --all` | 同上，但重启当前目录所有会话的 HUD pane |
| `codex-hud --toggle-mode` | 不切换焦点，切换单 Session/概览模式 |
| `codex-hud --cycle-details` | 不切换焦点，循环切换工具详情级别 |
| `codex-hud --list` | 列出所有 codex-hud session，附带工作目录、attach 状态，以及 HUD pane 是否还活着——HUD 进程比磁盘上的构建更旧时标注 `HUD: outdated`；当前目录最新的那个会话（启动或 attach 自动选择的对象）标注 `(newest here…)` |
| `codex-hud --hud-version` | 显示包版本和 checkout revision |

## HUD 显示了什么？

默认使用终端前景色与青色强调，项目名加粗，标签弱化，默认收起已完成工具历史；黄色表示需要注意的权限、审批或容量状态，红色表示错误或容量危险。概览以留白对齐各列。按 `d` 可查看完整环境清单、Git 文件统计、token 拆分与会话标识；按 `t` 只改变工具详情。任务标题优先于运行时长和长分支，并省略提示词开头重复的当前目录。窄窗先缩减进度条及剩余 token 数，保留 Context 百分比和加粗的 compact 次数；标题为 `[view]` 按钮保留位置。

预览：[浅色终端](./doc/fig/single-light.svg) · [60 列窄窗](./doc/fig/single-narrow.svg)。预览来自实际渲染器，可用 `npm run docs:previews` 重新生成。

```text
my-project git:(main *)  gpt-5.6-sol high  fix the flaky e2e run  up 12m
[FULL ACCESS] · Fast: on
Ctx: ███████▁▁▁▁▁ 55% left (70.4K) · ↻3
● Thinking 42s · event 8s ago
● exec: npm test 1.4s · ✗ exec: rg pattern @other-repo exit 1
```

上下文进度条是"油量表"语义：实心格表示剩余量，与旁边的 `% left` 文字一致；颜色反映压力（青 → 黄 → 红）。`Last call` 是最近一次模型请求的 token 用量，一个用户回合可能包含多次模型请求，`Total` 是本 session 的累计消耗。标题取自会话的首条提示词。全部字形都来自一套在缺少半填充圆和浅色阴影的终端字体上验证过的安全集（◐ ░ ⏸ 在那里会变宽或高度不齐）：活动标记是每绘一帧跳一次的圆点，进度条底纹是低块，暂停的调用标 `▲`。

尚未绑定 Codex session 时，HUD 显示 `○ Waiting for a Codex session…`，而不是渲染一个可能被误认为故障的半截画面。

| 行 | 内容 |
|----|------|
| **标题** | 项目名、git 分支、模型 + effort，以及绑定的 Codex 会话已运行多久。首轮采集完成前模型显示为 `…`、不显示时长，因为此时两者都还不知道 |
| **安全与环境** | `[FULL ACCESS]`、审批/Sandbox/Fast 优先（徽章已蕴含的单元不再重复显示，默认态 `Fast: off` 直接省略——上方两行的 Codex 底栏已经写着它）；MCP、Codex skill、hook、AGENTS.md 和配置来源仅在 `full` 详情模式显示。pane 行数不够而这些单元又都放得进第 1 行旁边时，整行上移到第 1 行，不再占一行。审批与沙箱的取值序：先读会话自身的记录，再读主 pane 活体 Codex 进程的启动 flag（`--yolo`、`--ask-for-approval …`——flag 覆盖配置文件，而 0.149 会话在首条消息前没有任何记录可承载它们），最后才回退配置文件；绑定的会话既无记录、flag 又读不到时显示 `?`/`[ACCESS ?]`，而不是把被覆盖的配置当作事实展示。有一个例外可提前恢复配置资格：捕获到的 argv 被完整走查到末尾、既无策略 flag 也无 profile，即证明配置未被覆盖——素启动不再要等到首条消息才摘掉 `?` |
| **容量** | 默认显示 Context 剩余百分比/剩余 token 与 compact 次数；输入/cache/输出拆分和累计消耗在完整详情中显示；只要版面还有空行就显示限额窗口及其 reset 时刻——以剩余量表述（`5h 6% left`），与上方的 Context 仪表、下方 Codex 自己的底栏方向一致——使用率达到 70% 后转为高亮告警；reset 时刻已过的限额快照直接不显示，不再重放。限额是账号级状态，取本机任一 Codex 会话写下的、**确实报出了读数的**最新快照，而不是绑定会话碰巧最后看到的那一份——窗口耗尽后 Codex 会写出不含任何窗口的快照，直接取最新的那份会让配额行在 100% 时反而消失。若快照没有任何窗口但信用额度为空，则显示 `credits: 0`；处于这种耗尽期时，扫描会继续向更旧的文件走，直到找到仍然写明 reset 时刻的读数，而不是数满固定文件数就停。找到的那份读数的窗口会被保留到耗尽快照本身上，因此配额行仍然给出「什么时候能继续干活」这一个数字：`5h 0% left · resets in 3h47m · credits: 0`——2026-08-31 实测，5h 窗口的 reset 时刻（Codex pane 自己写着 "try again at 9:18 PM"）此前会在整整 3h47m 里从 HUD 上消失。reset 距今不足一天时改为倒计时（`resets in 2h13m`）；窗口用掉一半之后——或者基线已有整整一天的读数，两者先到为准——两份带时间戳的读数即可算出该窗口的燃速，若按此速率会在其 reset 之前耗尽，则在行上标出并注明窗口（`→ 7d empty ~08/22`、`→ 5h empty in 40m`）。Codex 0.150 把单一 weekly 窗口换成了 5h primary、weekly 降为 secondary；追踪器按窗口长度各存一条基线，weekly 预测因此在换位后仍然成立——单序列追踪器会把每份 5h 快照误判为 weekly 的陈旧重放，从此静默停止学习。燃速基线通过一个小的每用户状态文件共享，因此每块 HUD 对同一账号给出同一预测——此前两块面板曾相差约一天——`--reload` 也不再把基线清零重来 |
| **健康** | Git、会话日志、agent、项目扫描、配置、概览采集以及 HUD 自身显示的状态（自然语言描述），以及本版本无法识别的 Codex 响应/事件记录条数与类型名（`2 unrecognized Codex records: item_started`）。未知的**顶层**记录类型（Codex 几乎每次发版都会新增一种，0.153 是 `token_usage_record`）单独放在一条暗色备注里、写明类型名，是最先让位的行，不算告警；同一条备注在 tmux/ps/git 探测超过两秒时写 `probes slow · tmux 5.4s`，让"机器太忙导致面板陈旧"与"面板死了"区分开。尚未完成首轮的采集器保持沉默，只有跑过又停了才算告警。HUD 运行期间 `dist/` 被重新构建时，这里会出现一条暗色的 `HUD updated on disk · codex-hud --reload`——pane 里跑的永远是它启动那一刻的构建 |
| **活动** | Thinking/Running tool/Responding/Idle、工具耗时/结果、计划进度和活跃 subagent；空闲会话还会显示上一轮耗时。被 Codex 自己以错误结束的回合（`task_complete.error`：撞上用量限额、模型满载、流中途断开）显示为 `✗ Turn failed · usage limit · after 16m17s`——给出提供方的裁决和被浪费掉的时长，绝不当作完成：2026-08-31 实测，两个活跃会话 12 个回合里有 4 个以这种方式结束（其中一个跑了 35 分钟），此前每一个都显示为 `✓ Idle · waiting for you` 并按「跑完了」发了通知。所有被包装的 shell 命令统一显示为 `exec`——同一类活动只有一个名字，无论 Codex 发来的是单条命令还是一段跑多条的脚本（包装的非 shell 工具如 `web_search`、`update_plan` 仍显示各自的名字）。`@目录` 标记只出现在跑在会话目录之外的命令上；Codex 每次调用都携带 workdir，给会话 cwd 本身打标记说不出任何信息。命令非零退出会标记为 `✗` 并显示退出码——包括 Codex 把它放在一段自身执行成功的脚本里运行的情况。stream error 只画在 Codex TUI 上、不写入会话日志，被它打断的回合会永远停在 `Thinking`；静默数分钟后 HUD 会去主 pane 查错误横幅，只有确认存在才显示 `✗ Turn likely interrupted`。Codex 自身退出（quit、崩溃或拒绝信任提示）时，wrapper 会把 pane 交还给你的 shell，而磁盘上没有任何记录说明这件事；对安静的会话，HUD 会探测主 pane 进程树里是否还有活着的 Codex（Codex 以孙进程形态运行，tmux 自己的 pane 命令始终显示为 shell），没有则显示 `○ Codex exited · run codex to restart`，不再假装在等待一个没人会输入的回合。`/new` 之后，Codex 0.149 在首条消息之前不落任何痕迹——没有 rollout、也没有会话库行——上一个会话的末状态会因此一直挂着；安静 pane 的输入区底栏若显示全新会话（`Context 100% left · Ready`），则改显 `○ New session at the prompt · binds on its first message`；该提示存在期间，上一个会话的 Context/Token 行、工具历史行连同 Session 行的 Session/CLI/Provider 三格一起转为 dim（目录与账号配额保持原色），HUD 上再没有亮色信息与 pane 自己的底栏对立 |
| **Session** | 工作目录、Session ID、CLI 版本；排在计划和工具历史之后，小 pane 优先保留动态信息。Session ID 在行宽允许时完整显示——`codex resume`、`fork`、`archive`、`delete` 接受的正是它；pane 更窄时才回退为缩写形式 |

版面是双向自适应的。有余量时会同时保留回合行与运行中工具行，因为两者计的不是同一个数：回合行是 Codex 连续执行工具的时长，工具行是当前这一条调用的时长。pane 放不下时，先从最压缩的形态起步——多条 agent 折叠成一行 `● N agents` 计数、工具行旁不带回合行、不显示平静配额、环境单元并入第 1 行（放不下就只留 `[FULL ACCESS]` 徽章）、不显示 Session 行——再按价值逐项回填，放得下就保留：先展开 agent，再回合行，再平静配额，再环境独立行，再 Session 行，最后才是暗色的未识别记录备注。有状态可显示时不会留空行，pane 越高只会显示越多。自适应高度模式下 pane 本身也跟随内容：增长到未裁剪版面需要的行数（上限 `CODEX_HUD_HEIGHT_MAX`，至多每十秒一次），内容持续变少两分钟后再收缩；你手动拖出的高度会一直保留到内容变化为止（`CODEX_HUD_HEIGHT_FIT=0` 关闭）。

窄 pane 上按"整个单元"舍弃，而不是把词截断。标题行保住项目名、收缩分支名；环境行取其优先级序列中能放下的最长前缀——权限在前、清单计数在后——实在放不下就整行让出，而不是显示半句安全状态。因为取的是前缀而不是能塞就塞，把 pane 拖宽只会增加单元，短的低优先单元也不会再占掉高优先单元的位置。

工具活动默认仍只占一行。默认 `CODEX_HUD_TOOL_DETAILS=targets`：执行类工具只显示保护隐私的**命令头部**——程序名加一个已知子命令或脚本名（如 `npm test`、`sed && rg`），不含任何参数、路径或标志；文件类工具只显示脱敏后的目标。heredoc 正文是数据不是命令：`python3 <<PY` 显示为 `python3`，正文行既不会造出假命令头，也不会抢占后续真实命令的显示名额。`full` 才显示已脱敏、限长后的完整命令摘要，`off` 隐藏目标细节，仍保留运行数量与失败结果。原始 stdout/stderr 和原始工具参数不会被保留或显示。

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
`login`、`mcp`、`completion`、`apply`、`doctor`、`update`、`queue`、
`migrate-rollouts`、`agents`、`--version` 等——就地执行并保留自己的 stdout，所以
`codex exec "…" | jq`、`codex queue "…"`、`codex completion zsh >> ~/.zshrc` 的
行为与不装 wrapper 时一致。`codex help` 是 Codex CLI 自己的帮助，
`codex-hud --help` 是本 wrapper 的帮助。

<details>
<summary>更多命令</summary>

```bash
codex-hud --kill             # 终止当前/唯一会话（--all：全部）
codex-hud --list             # 列出所有 HUD 会话
codex-hud --attach           # 复用已有会话
codex-hud --new-session      # 强制新建会话
codex-hud --doctor           # 运行环境诊断（--self-check 的别名）
codex-hud --reload           # 重启当前/唯一会话的 HUD pane；支持 `--target` 明确指定
codex-hud --reload --all     # 重启当前目录所有会话的 HUD pane
codex-hud --toggle-mode      # 切换单 Session/概览模式
codex-hud --cycle-details    # 循环切换工具详情级别
codex-hud --hud-version      # 显示版本与 revision
```

</details>

## 配置

### 环境变量

HUD 显示类变量在会话创建时从你的 shell 捕获，`codex-hud --reload` 会重新捕获。
运行中的 HUD 自己永远看不到之后的 `export`：tmux pane 继承的是 tmux server 的
环境而不是你 shell 的，所以 wrapper 会把所有被消费的变量烘焙进 pane 启动命令。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CODEX_HUD_POSITION` | `bottom` | HUD 面板位置（`top` / `bottom`） |
| `CODEX_HUD_HEIGHT` | 自适应 `5–12` | 默认取终端高度的六分之一，也可显式指定固定行数 |
| `CODEX_HUD_MOUSE` | `1` | 为会话启用 tmux 鼠标模式；点击 `[view]` 切换视图；滚轮由 HUD 接收，不改变显示模式 |
| `CODEX_HUD_TOOL_DETAILS` | `targets` | 工具详情：`off` / `targets` / `full`，聚焦后按 `t` 切换 |
| `CODEX_HUD_DETAILS` | `compact` | HUD 信息量：`compact` / `full`，聚焦后按 `d` 切换 |

<details>
<summary>全部环境变量</summary>

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CODEX_HUD_HEIGHT_AUTO` | 自适应高度：`1`；显式高度：`0` | 窄 pane 最多额外增加 3 行 |
| `CODEX_HUD_HEIGHT_MIN` | 自适应：`5`；显式高度：`CODEX_HUD_HEIGHT` | 自动模式最小高度 |
| `CODEX_HUD_HEIGHT_MAX` | `12` | 自动模式最大高度 |
| `CODEX_HUD_HEIGHT_FIT` | `1` | 自适应高度模式下，让 HUD 把 pane 增长到内容需要的行数，并在安静两分钟后收缩；显式 `CODEX_HUD_HEIGHT` 会关闭它 |
| `CODEX_HUD_AUTO_ATTACH` | `0` | 即使传入 Codex CLI 参数也自动复用会话 |
| `CODEX_HUD_ALTERNATE_SCREEN` | `0` | codex pane 的 tmux alternate-screen |
| `CODEX_HUD_BIND_TOGGLE` | `auto` | 作用于整个 tmux server 的 `Prefix+H` HUD 切换键：未设置时只要该键未被占用就安装，`1` 总是安装，`0` 从不安装 |
| `CODEX_HUD_CLEAR_SCROLLBACK` | `0` | 首次渲染时清理 scrollback |
| `CODEX_HUD_HISTORY_LIMIT` | `10000` | 仅 HUD pane 使用的 scrollback 行数；主 pane 保留继承值 |
| `CODEX_HUD_TOOL_DETAILS` | `targets` | 执行类默认显示命令头部（如 `npm test`）；`full` 显示脱敏摘要，`off` 隐藏目标细节，仍保留运行数量与失败结果（运行时可用 `t` 键或 `codex-hud --cycle-details` 循环切换）。shell 内建命令不算命令：`ffmpeg … ; echo ; exit` 显示为 `ffmpeg` |
| `CODEX_HUD_MODE` | `single` | 初始显示模式：`single` 或 `overview` |
| `CODEX_HUD_LOG_FILE` | 每用户默认路径 | 将 HUD 诊断信息（watcher/渲染/追踪错误）追加写入该文件。macOS 默认 `~/Library/Logs/codex-hud/hud.log`，其他平台为 `$XDG_STATE_HOME/codex-hud/hud.log`；设为 `off` 则丢弃 |
| `CODEX_HUD_NO_ATTACH` | `0` | 已废弃：强制新建会话而不复用 |
| `CODEX_HUD_SHOW_OTHER_AGENT_SKILLS` | `0` | 额外显示 `.agents` 的 skill 数；Codex skill 权威目录仍是 `CODEX_HOME/skills` |
| `CODEX_HUD_NOTIFY_CMD` | （未设置） | 会话进入需要人来处理的状态——等待审批、回合被打断、撞上限额（`approval-needed` / `turn-interrupted` / `limit-reached`）——或跑完一个三分钟以上的回合（`turn-completed`，payload 带 `turnDurationMs`；更短的回合结束时你多半正看着屏幕）时执行的 shell 命令；被 Codex 以错误结束的回合不论长短都改发 `turn-failed`，payload 带 `turnDurationMs` 与提供方的 `error`（`code`、`message`）。事件 JSON 通过 stdin 与 `CODEX_HUD_EVENT_JSON` 传入，事件名单独放在 `CODEX_HUD_EVENT`。只在状态跃迁时触发——启动或换绑后的首次观察只记基线不通知，抖动的状态每五分钟至多通知一次。示例：`CODEX_HUD_NOTIFY_CMD='osascript -e "display notification \"$CODEX_HUD_EVENT\" with title \"codex-hud\""'` |
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

上方预览由当前 HUD 渲染器使用示例数据生成，可用 `npm run docs:previews` 重新生成。

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
| 2026-09-10 | 冷启动优先绑定真实会话；静默工作状态检查进程存活；列表共用进程快照；重启失败/启动即退出如实报错；RC 符号链接、权限和重复安装保护；默认收起静态详情，`d` 独立展开，滚轮不切换模式，标题优先于运行时长；74server 纳入 CI |
| 2026-09-05 | rollout 变化即时上屏（fs.watch + 唤醒重排渲染 tick）；版面改为回填式行预算、环境行并入第 1 行；pane 高度跟随内容；鼠标上报（点击切视图、滚轮切详情，不再进 copy-mode 冻结）；首条提示词作会话标题上第 1 行与概览；验证安全字形集与逐帧 spinner；`Turn:` 标签；未识别记录备注写明类型；探测慢备注；命令头过滤 shell 内建；进程树与 Codex pid 缓存替代大部分 `ps`；工具完成触发 git 刷新；多 HUD 共享账号配额/git 快照；慢采集器进程内异步执行（不再有 worker isolate）；`Prefix+H` 未占用即安装；`--cycle-details`；`--list` 标注最新会话；`--doctor` 报告通知钩子 |
| 2026-09-03 | 白名单收录 codex 0.153 的 `token_usage_record` |
| 2026-09-02 | 回合失败相位与 `turn-failed` 通知；耗尽快照保留窗口；配额行改剩余语义；24h 基线预报放行 |
| 2026-08-28 | 按窗口分序列的燃速追踪（0.150 5h/周窗口换位）；`exec` 展示名；fresh 提示下 Session 行降暗；同目录 workdir 省略；argv 认证 |
| 2026-08-24 | 跨批次 token 保留；全部消费变量烘焙进 pane 命令；`/new` 新提示符探测；0.149 子命令透传；`turn-completed` 通知；共享燃速基线；活体进程读取启动 flag |
| 2026-08-20 | 配额扫描越过退化快照；`HUD updated on disk` 提示；`CODEX_HUD_NOTIFY_CMD`；reset 倒计时；燃速预报；`Codex exited` 探测 |
| 2026-08-19 | 耗尽后配额行不消失；完整扫描后 `Fast: ?` 转正；`--kill` 只杀最新会话；上一轮耗时；`--doctor` 显示日志；stream error 中断探测 |
| 2026-08-13 | 0.147 code-mode 工具细节与退出码；`codex` 子命令透传；完整 session id；概览配额与冷启动自身行 |
| 2026-08-12 | 限额时效与账号级来源；行预算版面；概览列出在开 HUD；有界首读；占位首帧；平静配额；概览地址列；`--list` 详情 |
| 2026-08-05 | pane 内 Ctrl+C；remain-on-exit；`--reload --all`；首帧不等采集器；渲染记忆化；worker 重建 |
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
