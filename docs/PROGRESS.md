# 变更记录

## 2026-01-29
- 修复 HUD 会话复用失效、macOS hash 兼容、参数转义与固定高度问题。
- 修复 rollout 增量解析竞态、跨批次完成丢失与截断重复统计。
- 新增 issues 归档与索引，统一记录修复状态。
- 更新 README 预览图为 `preview.png`。
- 增加 HUD 高度自适应能力，并补充环境变量说明。
- 窄屏时对 HUD 行进行 ANSI 安全截断，避免换行导致的重复/错位显示。
- 增加刷新时清空滚动历史选项，避免滚动区堆积大量旧帧。
- 改进窄屏下模型/进度显示，优先保留进度条与百分比。

## 2026-01-30
- 取消 HUD 宽度阈值自动增高，默认 `CODEX_HUD_HEIGHT_AUTO=0` 保持固定高度。
- 更新 README 与 issues 索引，新增 HUD 自动增高无效的问题记录。

## 2026-08-04
- 会话绑定 sqlite 查询改用 MATERIALIZED CTE 固定走 ts 索引（273MB logs 库实测单次 ~40-140ms 降至 ~14ms），旧版 sqlite CLI 自动回退平铺查询。
- 渲染路径去 throw：agent 计时时钟偏差 clamp 为 0，未知状态/无效计时降级为 display error 行，避免单条坏 rollout 记录导致 HUD 整体空白。
- HUD pane resize 立即失效重绘（含全屏清理），不再等待下一个刷新周期；滚动区清理保持仅首帧一次。
- 清理死代码：render/index 的 initRenderer/render/renderSingleLine、header 的 legacy 导出、未被引用的 session-line.ts。
- 回退扫描增加 rollout 首行 cwd 缓存（已解析永久缓存，未解析按文件增长失效）；绑定稳定时探测节奏 4s 自适应放宽至上限 12s，变化/失败即回落。
- 新增 GitHub Actions CI（ubuntu，Node 20/22 矩阵，typecheck+build+unit+integration）。

## 2026-08-04（第二轮）
- 修复 compactCount 双计：codex 对同一次压缩同时写顶层 `compacted` 与 `context_compacted` 事件（38 个真实 rollout 实测 1:1），改为分别计数取 max，对只写一种记录的版本同样正确。
- 工具详情显示：read/write/edit 的路径改头部截断保留文件名；失败调用详情在窄屏不再让位给运行中工具。
- 新增运行时热键 `t` 循环工具详情 targets → full → off（环境变量仅作初始值），按键即时重绘；更新 HUD 提示文案并在运行 5 分钟后自动隐藏提示。
- stderr 污染治理：watcher 回调失败、agent 追踪错误、渲染异常不再写 stderr（会落进 HUD 帧），改为 CODEX_HUD_LOG_FILE 可选落盘；界面失败状态仍由 health/tracking 行呈现。
- overview 解析器改有界 LRU（20）保留，会话短暂离开活跃窗口后回归时增量续读而非全量重读。
- 探测用 sqlite 只读句柄常驻复用（出错即弃重开，容量上限防轮转泄漏）；jsonl 读取改 allocUnsafe；文件链接改 file:///（空 authority，兼容 iTerm2 等对主机名链接的拒开）。
- 清理 git.ts legacy execSync 函数族（保留脚本引用的 collectGitStatus）。
- 调查结论：exec_command_begin/end 事件自 2026-06 起不再写入 rollout，文本信封是 exit code 唯一来源，维持现状；ISSUES.md 对齐 011（已修复）与 014（默认关闭已缓解）状态；README（en/zh）补充 Node 22.5+ 推荐说明。

## 2026-08-05（第三轮）
- 交互：HUD pane 内 Ctrl+C 不再被 raw mode 吞掉（显式处理 \u0003 走 shutdown，恢复光标）；新建会话的 HUD pane 设 remain-on-exit（tmux ≥3.0，静默降级），退出/崩溃后留下死 pane，`--reload` 的 respawn-pane 可直接复活而非布局塌陷；`--reload` 新增 `--all`，一次重启当前目录全部会话的 HUD pane（此前只处理最新会话，旧会话需手动 respawn-pane）；`--help` 增补 HUD 按键说明。
- 启动体验：首帧不再等待 git + slow-project 首轮采集（实测 937ms → 348ms，剩余为 node 进程与模块加载；负载高时收益更大），先渲染占位帧再由采集器异步填充；移除多余的 "Codex HUD starting..." 输出。
- 渲染性能：visualLength 加有界记忆化（2048 clear-on-full；帧间行文本高度重复，重复串 21µs → 0.06µs），graphemeWidth 增加单字符 ASCII 快路径（truncateAnsi 44µs → 22µs）；整帧改单次 stdout.write（原每行一次，且消除撕裂窗口）。
- 韧性：slow-project worker 崩溃后按需重建（1s→30s 有界退避，成功即复位；原实现一次崩溃后永久失效）；AsyncSnapshotCache 失败后按 errorRetryMs（默认 min(ttl, 15s)）节流重试，git 持续失败不再每秒重 spawn。
- 显示：overview 用 ▸ 标出当前 HUD 绑定的会话行；plan 行步骤截断随 pane 宽度伸缩（30–64 字符）并保证不溢出；token 行窄屏时整段丢弃 in/cache/out 明细而非从中间截断。
- RolloutParser.parse() 增加 size 短路：文件未增长（fallback 每 2s 轮询）直接返回缓存结果，不再空读+全量 merge。
- 清理：删除死代码 collectActivityLines（相关测试改走 renderHud 生产路径断言真实顺序）与重复的 renderContextProgressBar（统一 coloredBar）；docs/TODO.md 016 条目移除（已有集成测试覆盖）。
- 文档：README（en/zh）补 CODEX_HUD_LOG_FILE / MODE / NO_ATTACH 与内部变量说明、`t` 热键、`--reload --all`。
- 验证：typecheck+build 通过；unit 38 PASS、integration 28 项 rc=0（含新增 parse-skip、overview-self-marker、plan-token-width 单测与 worker 崩溃重建集成用例）。

## 2026-08-06（第四轮）
- fd 治理（P0）：chokidar 4+ 无 FSEvents，macOS 上 sessions 根 watcher 对整个 rollout 历史逐文件/目录建 kqueue watch（实测单 HUD ~1395 个 fd，且每新增 rollout 永久 +1，容器 ulimit 1024 场景会随历史打爆）。新增 `isStaleSessionDatePath` 谓词接入 chokidar `ignored`：结束早于 48h 窗口的日期目录整棵剪掉、不再下钻，谓词按当前时钟评估，跨午夜新目录自动纳入。实测 scratch 实例 fd 总数 1427 → 26（sessions 相关仅 5）。
- watcher 事件时延：三个 watcher 全带 awaitWriteFinish（100ms 静默阈值 + 50ms stat 轮询），而 rollout 解析本就按 committed-offset 容忍半行——活跃期事件被压到写入出现静默才发，且对每个正在写的 rollout 高频轮询。改为默认关闭，仅 config watcher 保留（半写 config.toml 会解析成错误帧）。
- 深度空闲退避（P2）：新增纯函数 `utils/idle-policy.ts`（planCadence），按"距最后活动时间 ≥10min 且无活跃 turn/tool/agent 且非 overview"进入 deep idle：render 1.5s→3s、git 5s→60s、agents 1s→5s、rollout 兜底 2s→10s、SessionFinder full-resolve 上限 12s→60s（setDeepIdle，退出时立即收缩）。非 git 目录任何状态下 git spawn 都降为 60s 一次。唤醒信号（按键/SIGUSR1/resize/config 或 rollout watcher 事件/绑定 rollout mtime/turn 活动）即刻恢复基础节奏。绑定会话空闲 30h 的实测背景：旧实现每 HUD 消耗 2.1-2.5% CPU（sample 顶栈为 __posix_spawn）；修后 scratch 实例基础节奏 20s 增量 0.07s ≈ 0.35%（无 pane 探测路径，非严格同条件，深闲档更低待线上复核）。
- 进程兜底：process 级 uncaughtException/unhandledRejection 记录到 CODEX_HUD_LOG_FILE 并继续运行；hud-log 增加 5MB 上限（超限重开并写截断标记）；jsonl-tail 新增 maxBytes 选项，agent-activity 全部 5 处读取按 64MB 上限，超限走 tracking-error + 退避而非撑爆内存。
- 环境行去冗余（UI）：`[FULL ACCESS]` 徽章蕴含的 `Approval: full access`/`Sandbox: off` 单元不再重复渲染（审批策略与徽章不一致时仍显示）；默认态 `Fast: off` 弱化为 dim。
- 主题与字形（UI）：theme.value 不再硬编码白色（SGR 37 在浅色终端不可见），改用终端默认前景；token 行分隔符与其他行统一为 dim 管道；⏱️/📝 两个 emoji 换成文本字形（`up 12m` dim 文本、`≡`，VS16 宽度歧义 + 全 HUD 其余字形均为文本系）；时长新增天数折算（`1d6h`）。
- 进度条语义（UI）：Ctx 条从"实心=已用"改为油量表——实心格=剩余量，与 `% left` 文字一致，颜色仍按已用压力（≥85% 红）；renderTokenLine、identity、overview 三处统一（coloredBar/progressBar 删除，新 remainingBar）。
- 启动：wrapper 启动命令注入 NODE_COMPILE_CACHE（Node 22+ 持久化 V8 编译缓存，老版本忽略；.cache/ 入 .gitignore）。
- 死代码清理：formatProjectPath、detectWorkMode/workMode、countInstructionsMdFiles/instructionsMdCount、hasCodexDir、collectGitStatus（同步族）、findActiveSession、getModelDisplayName 冗余 if 链、icons.clock/folder/file/tokens/arrow；tests/ 根目录 8 个确证腐化的 TS 脚本删除（引用 parseRolloutFile/getModelWithReasoning/mcp-status 等已不存在的 API；test-install.sh/test-e2e.sh 等近期仍被运行的 .sh 保留）；version 0.1.0 → 0.2.0。
- 文档：README（en/zh）示例帧同步新环境行/油量表语义并补说明。
- 验证：typecheck+build 通过；unit 39 文件 rc=0（新增 idle-policy 用例；file-watcher 增补剪枝谓词与旧目录不触发断言，并将原硬编码日期改为动态今日以防测试自然腐化；hud-log 轮转、jsonl-tail maxBytes、油量表方向断言）；integration 26 项 rc=0；scratch 实例实测 fd 26、帧内容确认徽章去冗余与 dim 分隔符生效、stderr 无输出。
