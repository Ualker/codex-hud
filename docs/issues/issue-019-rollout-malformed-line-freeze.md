# [中-高] rollout 单条坏 JSON 行导致解析永久失败

## 概要
`readCompleteJsonl` 对已提交（换行结尾）的坏 JSON 行直接抛异常且 offset 不推进。坏行不会因等待而修复，该文件的解析从此每轮失败；与 issue-017 叠加时升级为全局数据冻结。

## 影响
- HUD 主 rollout 解析：一条坏行即冻结工具/token/turn 数据。
- agent 权威跟踪：同样的行为在该场景是**有意设计**（协议漂移应显式暴露为 tracking error 并重试），不应更改。

## 位置
- `src/utils/jsonl-tail.ts:58`（修复前）

## 修复
`readCompleteJsonl` 新增 `skipMalformed` 选项：
- HUD rollout 解析（`rollout.ts`）开启：跳过坏行、推进 offset，计入 `protocolHealth.malformedLines` 并在健康行显示 `protocol malformed N`。
- agent-activity 保持默认严格模式：坏行仍抛错并走 tracking-error 重试（现带 1-10s 退避）。

## 验证
- `tests/unit/test-agent-jsonl-tail.mjs`：默认严格模式 reject；`skipMalformed` 模式跳过、计数、offset 越过坏行。
- `tests/integration/test-agent-activity-tree.mjs`：坏行→tracking-error→修复后恢复的既有契约保持通过。

## 修复记录
- 状态：已修复
- 修复人：claude
- 修复时间：2026-08-04
