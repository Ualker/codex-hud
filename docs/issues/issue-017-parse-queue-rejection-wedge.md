# [高] parse-queue 一次 reject 后永久卡死

## 概要
`createParseQueue` 中 `await parseInFlight` 抛出后，`parseInFlight = null` 永远不会执行。后续所有调用命中 `if (parseInFlight)` 分支，永远返回同一个已 reject 的 promise，`parseFn` 不再被调用。

## 影响
- 一次瞬态读错误（文件被移动、I/O 抖动、坏行异常）即让工具/token/turn 数据冻结到进程重启，且无任何界面提示。
- 与 issue-019（坏行异常）叠加时必然触发。

## 位置
- `src/utils/parse-queue.ts:23-24`（修复前）

## 复现步骤
1. 构造 `parseFn` 第一次调用 reject。
2. 连续调用队列函数 3 次。
3. 观察 `parseFn` 只执行 1 次，后两次调用返回同一个 rejected promise。

## 修复
`try/finally` 复位 `parseInFlight`，rejection 正常向当次调用方传播，后续调用重新执行 `parseFn`。成功路径语义（single-flight + trailing update）不变。

## 验证
- `tests/unit/test-parse-queue.mjs` 新增两个场景：单次 rejection 后恢复；rejection 期间有排队调用时双方都收到错误、随后恢复。

## 修复记录
- 状态：已修复
- 修复人：claude
- 修复时间：2026-08-04
