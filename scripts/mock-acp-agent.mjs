/**
 * 最小 ACP 代理，仅用于无头调度 spike / 测试：
 * initialize、session/new、session/prompt，回复一段固定文本后结束。
 */
import { createInterface } from 'node:readline';

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const rl = createInterface({ input: process.stdin });
let promptId = 0;

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'mock-acp', version: '0.0.1' },
        authMethods: [],
        agentCapabilities: {},
      },
    });
    return;
  }

  if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'mock-session' } });
    return;
  }

  if (message.method === 'session/prompt') {
    promptId += 1;
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'mock-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: `m${promptId}`,
          content: { type: 'text', text: 'mock scheduled reply' },
        },
      },
    });
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    return;
  }

  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  }
});
