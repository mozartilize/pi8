/**
 * Pi extension for tests. It registers the model `scripted/script`, which costs nothing.
 * The model reads the user request as a shell command, calls the `bash` tool with it once,
 * and then answers with the first line of the tool result.
 */
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function scriptedModel(pi: ExtensionAPI): void {
  const core = createFauxCore({ provider: 'scripted', api: 'scripted-api', models: [{ id: 'script' }] });
  const textOf = (content: unknown): string =>
    typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? '').join('') : '';
  core.setResponses([
    (context) => {
      const user = [...context.messages].reverse().find((message) => message.role === 'user');
      return fauxAssistantMessage(fauxToolCall('bash', { command: textOf(user?.content) }));
    },
    (context) => {
      const result = [...context.messages].reverse().find((message) => message.role === 'toolResult');
      return fauxAssistantMessage(fauxText(`done: ${textOf(result?.content).split('\n')[0]}`));
    },
  ]);
  pi.registerProvider('scripted', {
    baseUrl: 'http://localhost.invalid',
    apiKey: 'unused',
    api: 'scripted-api' as never,
    streamSimple: core.streamSimple as never,
    models: [{ id: 'script', name: 'Scripted', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }],
  });
}
