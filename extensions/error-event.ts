/**
 * Shared terminal error-event builder for the `router/auto` provider.
 *
 * The `AssistantMessageEventStream` contract (pi-ai utils/event-stream.js)
 * treats `event.error` as the FINAL assistant Message — pi then reads
 * `message.content.filter(...)` on it. A bare `{ message: text }` has no
 * `content` array, so that access throws
 * "Cannot read properties of undefined (reading 'filter')", which masks the
 * real error text. Emit a full, message-shaped error with `content: []` so
 * the router's own message survives to the UI.
 */
import { ROUTER_PROVIDER_ID } from './types.js';

export function makeTerminalErrorEvent(reason: 'error' | 'aborted', text: string) {
  const message = {
    role: 'assistant',
    content: [] as unknown[],
    api: 'router-auto-api',
    provider: ROUTER_PROVIDER_ID,
    model: 'auto',
    stopReason: reason,
    errorMessage: text,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  return { type: 'error', reason, error: message, message } as any;
}
