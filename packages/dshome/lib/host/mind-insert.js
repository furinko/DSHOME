// mind-insert.js — mind-inject / mind-recall 共用的「会话注入定位」逻辑（去重 + claimed 后插入）。
// 提取自两插件重复代码（A5 收敛）；纯逻辑、不依赖 node/fs，便于复用与单元验证。
// 插入通道与官方 agent-instructions 同构：把 newMessage 塞进 agent 消息流，随上下文携带。

/** 每会话只注入一次的守卫 key（session 弃后新会话重新注入）。 */
export function sessionKey(agent) {
  const id = agent?.session?.header?.id;
  return id ? `session:${String(id)}` : null;
}

/** 找 claimed 用户消息在 decision.messages 中的最后位置（用 Set 判属，O(n)）。 */
export function lastClaimedIndex(decision, messages) {
  const claimedSet = new Set(messages || []);
  return (decision.messages || []).findLastIndex((m) => claimedSet.has(m));
}

/**
 * 把 newMessage 插到 claimed 用户消息之后（指令/上下文不被稀释）；无 claimed 则放最前。
 * 保留 decision 其它字段（kind 等），不丢。
 */
export function insertAfterClaimed(decision, messages, newMessage) {
  const msgs = decision?.messages;
  if (!Array.isArray(msgs)) return decision;
  const idx = lastClaimedIndex(decision, messages);
  if (idx >= 0) return { ...decision, messages: msgs.toSpliced(idx + 1, 0, newMessage) };
  return { ...decision, messages: [newMessage, ...msgs] };
}
