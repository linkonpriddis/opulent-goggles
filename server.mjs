import { createServer } from 'node:http';
import { readFile, mkdirSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = dirname(fileURLToPath(import.meta.url));
const publicRoot = resolve(root, 'public');
const dataRoot = join(root, 'data');
mkdirSync(dataRoot, { recursive: true });

const database = new DatabaseSync(join(dataRoot, 'knowledge.sqlite'));
database.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS assistants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assistant_id INTEGER NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw Object.assign(new Error('Request is too large.'), { status: 413 });
  }
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 });
  }
}

function tokens(text) {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
}

function findMatches(question, assistantId) {
  const terms = tokens(question);
  if (!terms.length) return [];

  const entries = database.prepare(
    'SELECT id, title, content FROM entries WHERE assistant_id = ? ORDER BY id DESC',
  ).all(assistantId);

  return entries.map((entry) => {
    const title = entry.title.toLowerCase();
    const content = entry.content.toLowerCase();
    let score = 0;
    let matched = 0;

    for (const term of terms) {
      const inTitle = title.includes(term);
      const inContent = content.includes(term);
      if (inTitle || inContent) matched += 1;
      if (inTitle) score += 3;
      if (inContent) score += 1 + Math.min((content.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length, 4) * 0.15;
    }

    return { ...entry, score: score * (matched / terms.length), matched };
  })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);
}

function excerpt(content, question) {
  const lowerContent = content.toLowerCase();
  const firstMatch = tokens(question)
    .map((term) => lowerContent.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, firstMatch - 110);
  const end = Math.min(content.length, start + 320);
  return `${start > 0 ? '...' : ''}${content.slice(start, end).trim()}${end < content.length ? '...' : ''}`;
}

function serveStatic(pathname, response) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }

  const requestedPath = decodedPath === '/' ? '/index.html' : decodedPath;
  const filePath = resolve(publicRoot, `.${requestedPath}`);
  if (!filePath.startsWith(`${publicRoot}${sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream' });
    response.end(contents);
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const route = url.pathname.match(/^\/api\/assistants(?:\/(\d+))?(?:\/(entries|ask))?$/);

  try {
    if (!route) {
      serveStatic(url.pathname, response);
      return;
    }

    const [, assistantId, action] = route;
    if (request.method === 'GET' && !assistantId) {
      const assistants = database.prepare(`
        SELECT assistants.id, assistants.name, assistants.description, assistants.created_at,
          COUNT(entries.id) AS entry_count
        FROM assistants LEFT JOIN entries ON entries.assistant_id = assistants.id
        GROUP BY assistants.id ORDER BY assistants.id
      `).all();
      sendJson(response, 200, assistants);
      return;
    }

    if (request.method === 'POST' && !assistantId) {
      const { name, description = '' } = await readJson(request);
      if (typeof name !== 'string' || !name.trim()) {
        sendJson(response, 400, { error: 'Give this assistant a name.' });
        return;
      }
      const result = database.prepare('INSERT INTO assistants (name, description) VALUES (?, ?)')
        .run(name.trim().slice(0, 80), String(description).trim().slice(0, 240));
      sendJson(response, 201, database.prepare('SELECT * FROM assistants WHERE id = ?').get(result.lastInsertRowid));
      return;
    }

    if (!assistantId) {
      sendJson(response, 404, { error: 'Not found.' });
      return;
    }

    const assistant = database.prepare('SELECT id FROM assistants WHERE id = ?').get(assistantId);
    if (!assistant) {
      sendJson(response, 404, { error: 'Assistant not found.' });
      return;
    }

    if (request.method === 'DELETE' && !action) {
      database.prepare('DELETE FROM assistants WHERE id = ?').run(assistantId);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && action === 'entries') {
      const entries = database.prepare(
        'SELECT id, title, content, created_at FROM entries WHERE assistant_id = ? ORDER BY id DESC',
      ).all(assistantId);
      sendJson(response, 200, entries);
      return;
    }

    if (request.method === 'POST' && action === 'entries') {
      const { title, content } = await readJson(request);
      if (typeof title !== 'string' || !title.trim() || typeof content !== 'string' || !content.trim()) {
        sendJson(response, 400, { error: 'Add a title and some information.' });
        return;
      }
      const result = database.prepare(
        'INSERT INTO entries (assistant_id, title, content) VALUES (?, ?, ?)',
      ).run(assistantId, title.trim().slice(0, 160), content.trim().slice(0, 100_000));
      sendJson(response, 201, database.prepare('SELECT * FROM entries WHERE id = ?').get(result.lastInsertRowid));
      return;
    }

    if (request.method === 'PATCH' && action === 'entries') {
      const entryId = url.searchParams.get('id');
      const { title, content } = await readJson(request);
      if (!entryId || typeof title !== 'string' || !title.trim() || typeof content !== 'string' || !content.trim()) {
        sendJson(response, 400, { error: 'Add a title and some information.' });
        return;
      }
      const result = database.prepare(
        'UPDATE entries SET title = ?, content = ? WHERE id = ? AND assistant_id = ?',
      ).run(title.trim().slice(0, 160), content.trim().slice(0, 100_000), entryId, assistantId);
      if (!result.changes) {
        sendJson(response, 404, { error: 'Entry not found.' });
        return;
      }
      sendJson(response, 200, database.prepare('SELECT * FROM entries WHERE id = ?').get(entryId));
      return;
    }

    if (request.method === 'DELETE' && action === 'entries') {
      const entryId = url.searchParams.get('id');
      if (!entryId) {
        sendJson(response, 400, { error: 'Entry id is required.' });
        return;
      }
      database.prepare('DELETE FROM entries WHERE id = ? AND assistant_id = ?').run(entryId, assistantId);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'POST' && action === 'ask') {
      const { question } = await readJson(request);
      if (typeof question !== 'string' || !question.trim()) {
        sendJson(response, 400, { error: 'Enter a question.' });
        return;
      }
      const matches = findMatches(question.trim(), assistantId);
      sendJson(response, 200, {
        answer: matches.length
          ? `I found ${matches.length} relevant ${matches.length === 1 ? 'entry' : 'entries'} in this assistant's information.`
          : 'I could not find a matching answer in this assistant’s saved information.',
        sources: matches.map(({ id, title, content }) => ({ id, title, excerpt: excerpt(content, question) })),
      });
      return;
    }

    sendJson(response, 405, { error: 'Method not allowed.' });
  } catch (error) {
    sendJson(response, error.status ?? 500, { error: error.status ? error.message : 'Something went wrong.' });
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, '0.0.0.0', () => {
  console.log(`Knowledge server ready at http://localhost:${port}`);
});