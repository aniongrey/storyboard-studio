import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const secretFile = () => process.env.STUDIO_SECRET_FILE || path.join(process.env.LOCALAPPDATA || process.cwd(), 'StoryboardStudio', 'runninghub.dpapi');
let cachedKey;

function powershell(script, input) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input, encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  }).trim();
}

export function getRunningHubKey() {
  if (cachedKey !== undefined) return cachedKey;
  if (process.env.RUNNINGHUB_API_KEY) return process.env.RUNNINGHUB_API_KEY;
  if (!fs.existsSync(secretFile())) return '';
  try {
    cachedKey = powershell('$ErrorActionPreference="Stop"; $null=[Reflection.Assembly]::LoadWithPartialName("System.Security"); $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))', fs.readFileSync(secretFile(), 'utf8'));
    return cachedKey;
  } catch {
    throw Object.assign(new Error('无法解密本机 RunningHub 配置，请在设置里重新保存密钥'), { status: 503 });
  }
}

export function saveRunningHubKey(key) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{16,256}$/.test(key.trim())) throw Object.assign(new Error('API Key 格式无效'), { status: 400 });
  const encrypted = powershell('$ErrorActionPreference="Stop"; $null=[Reflection.Assembly]::LoadWithPartialName("System.Security"); $bytes=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); $encrypted=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($encrypted))', key.trim());
  const file = secretFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, encrypted, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  cachedKey = key.trim();
  return { configured: true };
}
