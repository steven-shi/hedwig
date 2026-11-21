import { CONVERSATION_LIMITS } from '../ai/config.mjs';
export const testConfig = (overrides = {}) => ({
  endpoint: { baseUrl: 'https://example.test' }, apiKey: 'test-only-dummy',
  model: 'deepseek-flash', adminWechatId: 'parent-id', groupsEnabled: true,
  prompt: 'Test learning guide', limits: { ...CONVERSATION_LIMITS },
  ...overrides,
});
