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
