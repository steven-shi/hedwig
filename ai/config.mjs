import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const MAX_PROMPT = 8000;
const LEARNING_GUIDE = '你是由家长部署的学习助手。用适龄、清晰的语言答疑。辅导作业时先用提示、例子或步骤帮助理解，鼓励孩子自己尝试并检查思路。遇到正在进行的考试，不代答。不要索要姓名、学校、住址、联系方式或密码。遇到危险、健康或安全问题，鼓励及时找家长、老师或可信成年人。区分事实与角色扮演，拿不准时明确说明。';

export const CONVERSATION_LIMITS = Object.freeze({
  turns: 12, chars: 24000, users: 200, idleMs: 86400000, maxTokens: 1000,
});

export function loadConfig(file, root = process.cwd()) {
  let source;
  try { source = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error('Cannot read config.json. Check file permissions and JSON syntax.'); }
  if (!source || typeof source.endpoint !== 'string' || source.endpoint.length > 1000) {
    throw new Error('config.json requires an HTTPS endpoint.');
  }
  let url;
  try { url = new URL(source.endpoint); } catch { throw new Error('config.json endpoint is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('config.json endpoint must be HTTPS without credentials, a query or fragment.');
  }
  if (typeof source.apiKey !== 'string' || !source.apiKey.trim() ||
      /[\r\n]/.test(source.apiKey) || source.apiKey.trim() === 'replace-with-your-api-key') {
    throw new Error('Set your own API key in config.json.');
  }
  if (typeof source.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(source.model)) {
    throw new Error('config.json model is invalid.');
  }
  const adminWechatId = source.adminWechatId ?? '';
  if (typeof adminWechatId !== 'string' ||
      (adminWechatId && !/^[A-Za-z0-9_@.\-]{1,256}$/.test(adminWechatId)) || adminWechatId.endsWith('@chatroom')) {
    throw new Error('adminWechatId must be a personal WeChat internal ID or an empty string.');
  }
  if (source.groupsEnabled !== undefined && typeof source.groupsEnabled !== 'boolean') {
    throw new Error('groupsEnabled must be true or false.');
  }
  let role = '';
  if (source.promptFile !== undefined && source.promptFile !== '') {
    if (typeof source.promptFile !== 'string') throw new Error('promptFile must be a path under prompts/.');
    const path = resolve(root, source.promptFile);
    if (!path.startsWith(resolve(root, 'prompts') + sep)) throw new Error('promptFile must be under prompts/.');
    try { role = readFileSync(path, 'utf8').trim(); }
    catch { throw new Error('Cannot read promptFile.'); }
    if (!role || role.length > MAX_PROMPT) throw new Error('promptFile must contain 1–8000 characters.');
  }
  return Object.freeze({
    endpoint: Object.freeze({
      baseUrl: url.href.replace(/\/+$/, ''),
      thinkingDisabled: url.hostname === 'api.deepseek.com',
    }),
    apiKey: source.apiKey.trim(), model: source.model, adminWechatId,
    groupsEnabled: source.groupsEnabled === true,
    prompt: role ? LEARNING_GUIDE + '\n\n角色示例：\n' + role : LEARNING_GUIDE,
    limits: CONVERSATION_LIMITS,
  });
}
