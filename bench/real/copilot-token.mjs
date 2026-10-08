import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
};

/**
 * Gets a new GitHub Copilot token and writes it to Pi's auth file. A run cannot reach api.github.com, so
 * the driver, which runs outside the run namespace, does this. The file is replaced in one rename, so a
 * Pi process that starts during the write reads the old or the new entry, never a partial file.
 * Returns the expiry of the new token in milliseconds since the epoch.
 */
export async function refreshCopilotToken(authPath) {
  const auth = JSON.parse(readFileSync(authPath, 'utf8'));
  const entry = auth['github-copilot'];
  if (!entry?.refresh) throw new Error('no GitHub Copilot login in the auth file');
  const domain = entry.enterpriseUrl || 'github.com';
  const response = await fetch(`https://api.${domain}/copilot_internal/v2/token`, {
    headers: { ...HEADERS, Authorization: `Bearer ${entry.refresh}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`the Copilot token request failed with status ${response.status}`);
  const body = await response.json();
  if (typeof body.token !== 'string' || typeof body.expires_at !== 'number') throw new Error('the Copilot token response has no token or expiry');
  // Pi treats a token as expired 5 minutes before the server does.
  const expires = body.expires_at * 1000 - 5 * 60 * 1000;
  // Read again: another Pi process may have written the file during the request.
  const latest = JSON.parse(readFileSync(authPath, 'utf8'));
  latest['github-copilot'] = { ...latest['github-copilot'], access: body.token, expires };
  const temporary = `${authPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(latest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, authPath);
  return expires;
}
