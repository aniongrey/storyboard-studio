import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function childEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/key|token|secret|password|credential|authorization/i.test(name)));
}

export class CodexAppServer {
  constructor({ codexPath = process.env.CODEX_PATH || 'codex', cwd = process.cwd(), spawnImpl = spawn, timeoutMs = 15000 } = {}) {
    this.pending = new Map(); this.sequence = 0; this.timeoutMs = timeoutMs;
    this.child = spawnImpl(codexPath, ['app-server', '--listen', 'stdio://'], {
      cwd, env: childEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && (message.result !== undefined || message.error)) {
        const waiting = this.pending.get(message.id); if (!waiting) return;
        clearTimeout(waiting.timer); this.pending.delete(message.id);
        message.error ? waiting.reject(new Error(message.error.message || 'Codex RPC 失败')) : waiting.resolve(message.result);
      } else if (message.id !== undefined && message.method) {
        // This UI cannot collect approvals; never approve or bypass them silently.
        this.child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32000, message: '需要在 Codex 中完成人工审批；此本地网页不自动批准。' } }) + '\n');
        this.onApproval?.(message);
      } else this.onNotification?.(message);
    });
    const failed = error => {
      this.failure = error;
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
      this.pending.clear(); this.onExit?.(error);
    };
    this.child.on('error', failed);
    this.child.on('exit', (code, signal) => failed(new Error(`Codex app-server 已退出 (${code ?? signal})`)));
    this.child.stderr.on('data', () => {});
  }
  request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} 超时`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'storyboard_studio', title: 'Storyboard Studio', version: '0.1.0' } });
    this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    return this.request('account/read', { refreshToken: false });
  }
  close() { this.lines.close(); this.child.kill(); }
}

export async function inspectCodex(options = {}) {
  let client;
  try {
    client = new CodexAppServer(options);
    const account = await client.initialize();
    return {
      available: true, loggedIn: Boolean(account.account), stdio: true,
      strictImageValidation: false, automaticImageGeneration: false,
      message: account.account
        ? 'App Server 可用且已登录。图片工具调用前的严格校验未验证，图片请使用当前 Codex 会话文件交付。'
        : 'App Server 可用，CLI 未登录。当前 Codex 会话文件交付不受影响；CLI 自动任务需要先登录。',
    };
  } catch (error) {
    return { available: false, loggedIn: false, stdio: false, strictImageValidation: false, automaticImageGeneration: false, message: error.message };
  } finally { client?.close(); }
}

export async function runPromptTask({ codexPath, cwd, instruction, onLog = () => {}, timeoutMs = 300000, spawnImpl }) {
  const client = new CodexAppServer({ codexPath, cwd, spawnImpl });
  try {
    const account = await client.initialize();
    if (!account.account) throw new Error('Codex CLI 未登录，请先执行 codex login；也可使用当前 Codex 会话文件交付。');
    let finish, fail;
    const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    done.catch(() => {});
    const timer = setTimeout(() => fail(new Error('Codex 文件任务超时；请检查任务目录后再刷新。')), timeoutMs);
    client.onExit = fail;
    client.onApproval = () => fail(new Error('Codex 要求人工审批，自动执行已停止；请在当前 Codex 会话继续。'));
    client.onNotification = message => {
      if (message.method === 'item/completed') {
        const item = message.params?.item;
        if (item?.type === 'agentMessage') onLog(item.text || '');
      }
      if (message.method === 'turn/completed') {
        const turn = message.params?.turn;
        turn?.status === 'completed' ? finish(turn) : fail(new Error(turn?.error?.message || `Codex 任务状态：${turn?.status}`));
      }
    };
    try {
      const { thread } = await client.request('thread/start', { cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request' });
      await client.request('turn/start', { threadId: thread.id, cwd, input: [{ type: 'text', text: instruction }] });
      return await done;
    } finally { clearTimeout(timer); }
  } finally { client.close(); }
}
