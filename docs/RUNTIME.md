# Runtime and recovery / 运行与恢复

Source boundaries: `rollout-discovery.ts` handles canonical files and metadata; `session-finder.ts` resolves pane/process ownership. SQLite only supplies discovery/binding evidence; quota and rendered activity still come from JSONL. Directory-scoped wrapper operations share `session_matches_current_directory`.

JSONL revision checks read a bounded header and the previous append boundary, including same-inode growing rewrites and same-size rewrites with unchanged timestamps. Unchanged files read at most 1 KiB of guard bytes; append checks read at most 1.5 KiB. Consumed token/quota numbers must be finite and non-negative; malformed records preserve the last valid state and are counted. SQLite workers retire after 30 seconds without queries and restart on demand. No pending query is retired.

## English

Codex 0.164.0 `additional_tools` records are recognized as tool definitions. They do not trigger compatibility warnings or count as tool executions; other unknown record types still produce diagnostics.

Codex 0.165.0 `configuration_update` records update the displayed reasoning effort without changing tool or turn activity. The setting also survives a HUD reload with a large session log; invalid consumed fields and other unknown record types still produce diagnostics.

Rollout reads discard stale work after rebinding, validate record envelopes, and replay large backlogs in bounded batches. `Catching up` identifies pending data. Notifications wait until the first bound log snapshot is caught up and remain suppressed while bytes are pending. Turn events are scoped by session/turn; quota alerts are scoped by data scope/window, so a new turn cannot repeat an unchanged quota alert. An explicit unavailable `CODEX_HOME` reports an error instead of reading another profile.

Daemon binding preserves identified connections of surviving TUI processes even after hours without request logs. Connect-line evidence takes priority; overlapping startup evidence stays unbound instead of guessing by launch order. Shared history retains connections belonging to live clients. `/side` conversations (temporary in-memory forks) and known helper threads do not replace the main session, including when `/side` closes; a normal persisted fork, `/new`, or `/resume` still updates the binding. After rebuilding, reload the HUD panes with `codex-hud --reload --target <tmux-session>`; the main Codex process keeps running.

Automatic reattachment, bindings, overview and shared quota use one data scope derived from canonical `CODEX_HOME` and `CODEX_SESSIONS_PATH` directories. Symlink aliases share a scope; different accounts in the same project do not. The overview shows session and attention counts plus the current filter; the scope identifier remains in diagnostics. Enter on a selection that disappeared reports it unavailable instead of opening another task. Legacy HUDs without scope metadata stay out of the overview until reloaded; `--doctor --json` marks their scope as unverified.

The overview retains at most 20 parsers and advances at most 8 per refresh, with a 100 ms scheduling budget (an already-started bounded batch finishes). Current, selected and actionable sessions receive priority; other rows rotate at a slower cadence and retain their last snapshot. Queued or catching-up rows say `Updating`. HUDs on the same data scope and tmux server share short-lived snapshots. Native and CLI SQLite probes are timed; native statements exceeding 50 ms log a query digest, row count and query plan without SQL literals.

Rollout changes invalidate shared overview reuse and bypass the ordinary per-row parse interval. On waking from deep idle, both the renderer and the overview data cache refresh. An older local parser cannot overwrite a newer adopted snapshot; existing backlogs and newly appended files share an age-based queue so continuously busy peers cannot starve catch-up work.

The periodic overview refresh uses the cadence interval directly. It bypasses the separate event-cache TTL, whose success timestamp can otherwise make a scheduled tick arrive slightly too early and double the normal refresh interval. File-event bursts still share the cache TTL.

In full details, `Skills enabled: enabled/discovered` describes filesystem inventory and inspected configuration, **not skills loaded in the current turn**. Sources include repository and user `~/.agents/skills`, `/etc/codex/skills`, legacy `.codex/skills`, and explicit system/admin roots. Canonical `SKILL.md` paths deduplicate symlinks; `[[skills.config]] enabled=false` in `CODEX_HOME/config.toml` disables entries. The HUD does not reproduce Codex's project trust or complete profile merge; runtime loaded count remains unknown.

Unexpected global exceptions stop the renderer. The wrapper restarts only that process with a capped backoff (three retries per crash burst), leaving Codex running; ordinary exits and startup configuration errors do not restart. Uninstall likewise stops only the HUD panes owned by this checkout and preserves main panes. Alias backups retain their original RC paths and shell dialects; newer user aliases and ambiguous legacy flat backups are preserved rather than overwritten.

The offline [performance benchmark](./PERFORMANCE.md) covers frame rendering and four concurrent long-log readers. `npm run bench:runtime` also exercises 1/5/20 full HUD processes, process binding, SQLite, tmux, Git, watchers and continuous log appends. Supported tmux tests and runtime benchmarks use private servers or substitutes. Legacy manual tmux/install entry points are retired. Runtime benchmarks clean up on success; failures retain per-HUD metrics, bounded stdout/stderr and exit details, and print their diagnostics directory.

## 中文

Codex 0.164.0 的 `additional_tools` 记录已按工具定义识别，不触发兼容警告，也不计为工具执行；其他未知记录类型仍保留诊断提示。

Codex 0.165.0 的 `configuration_update` 记录会更新显示的推理强度，不改变工具或任务状态。会话日志较大时，重载 HUD 也能恢复该设置；已消费字段格式异常及其他未知记录类型仍保留诊断提示。

日志解析会丢弃重绑定之前的旧读取，校验记录结构，并分批追赶大段积压。`Catching up` 表示仍在读取历史；首次绑定日志读完后才建立通知基线，积压尚未追平时暂停通知。任务通知按会话／回合隔离，额度通知按数据范围／额度窗口去重，切换回合不会重复提醒同一个额度告警。显式 `CODEX_HOME` 不可用时报告该目录错误，避免串到默认账号目录。


已知主 pane 时，只接受进程／连接或有效 pane snapshot 的归属证据；缺少证据时保持未绑定，不按目录或启动时间猜测。当前 rollout 的普通追加直接解析，不等待绑定查询；新文件、删除和周期检查仍处理换绑。跨文件额度采集保留最新耗尽状态及尚未重置的有效窗口。

连接 span 已被裁剪时，TUI 自身进程的 app-server 消息处理／发送模块日志仍可证明其运行的是进程内服务端；其他进程的服务端日志和客户端消息不算归属证据。长会话因此能在 HUD 重载后重新绑定，不依赖旧渲染器的内存状态。

daemon 绑定会保留仍存活 TUI 的已确认连接，即使数小时没有请求日志。优先使用明确的连接证据；启动时间重叠且证据不足时保持未绑定，不按启动顺序猜配。共享历史也会保留存活客户端所属的连接。`/side` 旁路会话（未持久化的临时 fork）和已识别的辅助线程不会覆盖主会话，`/side` 结束后也继续跟随原主任务；正常持久化的 fork、`/new`、`/resume` 仍会更新绑定。重新编译后，用 `codex-hud --reload --target <tmux-session>` 重载对应 HUD，主 Codex 进程继续运行。

自动重连、绑定公告、总览和额度共享统一使用 `CODEX_HOME` 与 `CODEX_SESSIONS_PATH` 的规范化目录作为数据范围；符号链接指向同一目录时视为同一范围。相同项目下的不同账号不会串接，总览顶部显示会话总数、待处理数与当前筛选；范围标识保留在诊断中。选择的会话已结束时，Enter 会提示不可用，不会自动跳到其他任务。旧 HUD 没有范围标识时不会被混入总览，重载后会自动发布新标识；`--doctor --json` 将其标为 `scopeVerified: false`。

总览按会话 ID 去重，以活跃 pane 的已验证绑定为准；子代理在进入解析队列前排除，避免缓存淘汰后出现占位残影。

总览最多保留 20 个日志解析器，每轮最多推进 8 个，解析调度预算 100 ms（已开始的单批读取会完成）。当前、选中和需处理的会话优先；其他行按较慢节奏轮换，保留最近快照。排队或积压中的行显示 `Updating`；同范围、同 tmux server 的 HUD 可复用短期总览快照。原生 SQLite 在独立 Worker 中执行，兼容旧 Node 的 CLI 查询仍异步执行；查询最多等待 8 秒，超时后重建 Worker。小型查询结果按数据库与 WAL 版本复用最多 750 ms，进程启动时间也只短暂共享，不缓存完整进程命令。原生 SQLite 与 CLI 查询都计时，原生单条查询超过 50 ms 时记录查询摘要、行数和查询计划，不写入原 SQL 参数。

日志变化会使旧的总览共享快照失效，并越过普通的单行解析间隔。深度空闲后的唤醒同时刷新画面和数据缓存；已接收的新快照不会再被旧的本地解析结果覆盖。已有积压与新追加日志按等待时间一起调度，持续繁忙的其他会话不会让积压一直排不到解析机会。

定时总览刷新直接遵循调度间隔，越过文件事件使用的缓存 TTL，避免成功时间比定时器稍晚时多跳过一轮、把正常刷新间隔翻倍。突发文件事件仍受缓存 TTL 限制。

JSONL 版本检查会读取有界文件头与上次追加边界，覆盖同一 inode 上变长的重写，以及容器内时间戳完全不变的等长改写。未变化文件的校验读取最多 1 KiB，追加时最多 1.5 KiB。实际消费的 token／额度数值必须有限且非负；坏记录计入诊断并保留上一次有效状态。SQLite Worker 连续 30 秒没有查询时退出，下次查询按需恢复；有未完成查询时不会回收。

完整详情里的 `Skills enabled: 已启用/已发现` 是文件与已检查配置的清单，**不是本轮已加载数**。包括项目各级与用户 `~/.agents/skills`、管理目录 `/etc/codex/skills`、旧 `.codex/skills` 和显式系统/管理目录；按真实 `SKILL.md` 路径去重，遵循 `CODEX_HOME/config.toml` 的 `[[skills.config]] enabled=false`。HUD 不模拟 Codex 的项目信任和完整 profile 合并；实际运行时加载数未知。

未捕获的全局异常会结束渲染器，wrapper 仅重启 HUD 进程并限制连续重试次数（三次，逐步退避）；主 Codex 继续运行。正常退出及启动配置错误不会自动重启。卸载也只停止本 checkout 登记的 HUD pane，保留主 pane。alias 备份按原始配置路径恢复，保留 shell 语法；如果用户已有更新的 alias，或遇到缺少来源信息的旧格式备份，会保留备份并提示，不覆盖当前配置。

离线[性能基准](./PERFORMANCE.md)覆盖多种高度、overview 和四个并发长日志读取器。`npm run bench:runtime` 另外覆盖 1／5／20 个 HUD 的进程绑定、SQLite、tmux、Git、watcher 和持续追加日志。正式 tmux 集成测试及运行基准使用隔离 server 或替身。旧的手工 tmux／安装测试入口已停用。运行基准成功后清理，失败时保留日志、退出信息与逐 HUD 指标，并打印诊断目录。

## Long idle validation / 长时间空闲验证

Run `npm run bench:runtime -- --instances 5 --seconds 12 --idle-seconds 750 --wake-seconds 8` to cross the real ten-minute idle threshold and observe worker retirement after cadence backoff. Use `--idle-seconds 3600` for a one-hour run. The benchmark asserts deep-idle cadence, fresh activity on each HUD's own overview row, binding identity and zero SQL failures, and reports idle resources separately. It uses synthetic logs and a private tmux server; failed runs preserve the idle phase and final runtime diagnostics.
