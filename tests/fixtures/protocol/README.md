# Codex 协议兼容 fixture

`0.157.1-communication.jsonl` 保留本机 0.157.1 取证确认的通信记录结构；标识符、正文、时间及加密字段内容均替换为固定测试值，不是用户日志原文。已在 test-rollout-agent-communication / test-agent-activity-protocol 中验证的结构集中在此，供兼容回放。

每次出现新记录时：记录观察到的 CLI 版本，提供脱敏最小结构，明确它对状态的语义，再扩展共享协议入口。未知类型仍应保留诊断，不能为了隐藏警告而接受未知生命周期事件。
