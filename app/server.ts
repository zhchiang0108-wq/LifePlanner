import express from 'express';
import pg from 'pg';
import { build } from 'esbuild';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { AuthResponse, Credentials, EventInput, PlannerEvent, PlannerTask, TaskInput, TaskPatch, User } from './shared';

const scrypt = promisify(scryptCallback);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export interface RunningApp { url: string; close(): Promise<void> }
interface EventRow { reminder_at?: Date | null; id: string; title: string; starts_at: Date; ends_at: Date; all_day: boolean; hidden: boolean }
const toPlannerEvent = (row: EventRow): PlannerEvent => ({ ...(row.reminder_at && { reminderAt: row.reminder_at.toISOString() }), id: row.id, title: row.title, start: row.starts_at.toISOString(), end: row.ends_at.toISOString(), allDay: row.all_day, hidden: row.hidden });
interface TaskRow { reminder_at?: Date | null; id: string; title: string; starts_at: Date | null; ends_at: Date | null; completed: boolean }
const toPlannerTask = (row: TaskRow): PlannerTask => ({ ...(row.reminder_at && { reminderAt: row.reminder_at.toISOString() }), id: row.id, title: row.title, start: row.starts_at?.toISOString() ?? null, end: row.ends_at?.toISOString() ?? null, completed: row.completed });
function validReminder(value: unknown): boolean {
  return value == null || (typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)));
}
function validTask(body: TaskInput): boolean {
  return validReminder(body.reminderAt) && typeof body.title === 'string' && body.title.trim().length > 0 && body.title.length <= 200 &&
    (body.completed === undefined || typeof body.completed === 'boolean') &&
    (body.confirmOverlap === undefined || typeof body.confirmOverlap === 'boolean') &&
    (body.confirmationToken === undefined || typeof body.confirmationToken === 'string') &&
    ((body.start === null && body.end === null) || validEvent({ ...body, start: body.start, end: body.end }));
}
function validEvent(body: unknown): body is EventInput {
  if (!body || typeof body !== 'object') return false;
  const b = body as EventInput;
  return validReminder(b.reminderAt) && typeof b.title === 'string' && b.title.trim().length > 0 && b.title.length <= 200 &&
    typeof b.start === 'string' && typeof b.end === 'string' &&
    /T.*(?:Z|[+-]\d\d:\d\d)$/.test(b.start) && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(b.end) &&
    Number.isFinite(Date.parse(b.start)) && Number.isFinite(Date.parse(b.end)) && Date.parse(b.start) < Date.parse(b.end) &&
    (b.confirmOverlap === undefined || typeof b.confirmOverlap === 'boolean') &&
    (b.confirmationToken === undefined || typeof b.confirmationToken === 'string') &&
    (b.allDay === undefined || typeof b.allDay === 'boolean') &&
    (b.hidden === undefined || typeof b.hidden === 'boolean') &&
    (!b.allDay || [b.start, b.end].every(value =>
      new Date(Date.parse(value) + 8 * 3600_000).toISOString().slice(11) === '00:00:00.000Z'));
}

export async function startApp(options: { databaseUrl: string; port?: number; host?: string }): Promise<RunningApp> {
  const pool = new pg.Pool({ connectionString: options.databaseUrl });
  const confirmationKey = randomBytes(32);
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, CHECK (starts_at < ends_at)
      );
      ALTER TABLE events ADD COLUMN IF NOT EXISTS all_day boolean NOT NULL DEFAULT false;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS reminder_at timestamptz;
      CREATE INDEX IF NOT EXISTS events_owner_time ON events(user_id, starts_at);
      CREATE TABLE IF NOT EXISTS tasks (
        id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        starts_at timestamptz, ends_at timestamptz, completed boolean NOT NULL DEFAULT false,
        CHECK ((starts_at IS NULL AND ends_at IS NULL) OR
          (starts_at IS NOT NULL AND ends_at IS NOT NULL AND starts_at < ends_at))
      );
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminder_at timestamptz;
      CREATE INDEX IF NOT EXISTS tasks_owner_time ON tasks(user_id, starts_at);
    `);
    const bundle = await build({ entryPoints: [fileURLToPath(new URL('./client.tsx', import.meta.url))], bundle: true, write: false, outdir: 'assets', minify: true, define: { 'process.env.NODE_ENV': '"production"' } });
    const js = bundle.outputFiles.find(f => f.path.endsWith('.js'))!.text;
    const css = bundle.outputFiles.find(f => f.path.endsWith('.css'))!.text;
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '16kb' }));
    app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin &&
        req.headers.origin !== `${req.protocol}://${req.get('host')}`) {
        res.status(403).json({ error: '不允許跨來源寫入' }); return;
      }
      next();
    });
    function token(req: express.Request) {
      return req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith('lp_session='))?.slice('lp_session='.length) ?? '';
    }
    // Called under the account write lock, after reading the latest conflicts.
    // A signed snapshot binds consent to this session, operation and interval.
    function conflictResponse(req: express.Request, res: express.Response, input: EventInput | TaskInput,
      conflicts: (PlannerEvent | PlannerTask)[], method = req.method, path = req.path) {
      const snapshot = conflicts.map(item => [
        'allDay' in item ? 'event' : 'task', item.id, item.title, item.start, item.end,
      ]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const confirmationToken = createHmac('sha256', confirmationKey).update(JSON.stringify([
        res.locals.user.id, digest(token(req)), method, path,
        new Date(input.start!).toISOString(), new Date(input.end!).toISOString(), snapshot,
      ])).digest('hex');
      return {
        error: '時段重疊：' + conflicts.map(item => `${item.title} (${item.start} – ${item.end})`).join('、'),
        conflicts, confirmationToken,
      };
    }
    function needsConfirmation(req: express.Request, res: express.Response, input: EventInput | TaskInput,
      conflicts: (PlannerEvent | PlannerTask)[]): boolean {
      if (!conflicts.length) return false;
      const response = conflictResponse(req, res, input, conflicts);
      if (input.confirmOverlap && input.confirmationToken === response.confirmationToken) return false;
      res.status(409).json(response);
      return true;
    }
    const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/' };
    app.post(['/api/auth/register', '/api/auth/login'], async (req, res) => {
      const { email, password }: Partial<Credentials> = req.body ?? {};
      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
        typeof password !== 'string' || password.length < 12 || password.length > 128) {
        res.status(400).json({ error: '請輸入有效電子郵件及 12–128 字元密碼' }); return;
      }
      const normalized = email.trim().toLowerCase();
      const register = req.path.endsWith('/register');
      let user: User;
      if (register) {
        const salt = randomBytes(16).toString('hex');
        const hash = (await scrypt(password, salt, 64) as Buffer).toString('hex');
        const result = await pool.query<User>('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3) ON CONFLICT(email) DO NOTHING RETURNING id,email', [randomUUID(), normalized, `${salt}:${hash}`]);
        if (!result.rows[0]) { res.status(409).json({ error: '此電子郵件已註冊' }); return; }
        user = result.rows[0];
      } else {
        const result = await pool.query<User & { password_hash: string }>('SELECT id,email,password_hash FROM users WHERE email=$1', [normalized]);
        const stored = result.rows[0];
        const [salt, hash] = stored?.password_hash.split(':') ?? ['dummy-salt', '00'.repeat(64)];
        const actual = await scrypt(password, salt, 64) as Buffer;
        if (!stored || !timingSafeEqual(actual, Buffer.from(hash, 'hex'))) { res.status(401).json({ error: '電子郵件或密碼錯誤' }); return; }
        user = { id: stored.id, email: stored.email };
      }
      const session = randomBytes(32).toString('hex');
      await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')", [digest(session), user.id]);
      res.cookie('lp_session', session, { ...cookieOptions, maxAge: 7 * 86400_000 });
      res.status(register ? 201 : 200).json({ user } satisfies AuthResponse);
    });
    app.use('/api', async (req, res, next) => {
      const result = await pool.query<User>('SELECT u.id,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()', [digest(token(req))]);
      if (!result.rows[0]) { res.status(401).json({ error: '請先登入' }); return; }
      res.locals.user = result.rows[0]; next();
    });
    app.get('/api/auth/me', (_req, res) => { res.json({ user: res.locals.user } satisfies AuthResponse); });
    app.post('/api/auth/logout', async (req, res) => {
      await pool.query('DELETE FROM sessions WHERE token_hash=$1', [digest(token(req))]);
      res.clearCookie('lp_session', cookieOptions).json({ ok: true });
    });
    app.get('/api/events', async (_req, res) => {
      const result = await pool.query<EventRow>('SELECT id,title,starts_at,ends_at,all_day,hidden,reminder_at FROM events WHERE user_id=$1 ORDER BY starts_at,id', [res.locals.user.id]);
      res.json(result.rows.map(toPlannerEvent));
    });
    app.get('/api/tasks', async (_req, res) => {
      const result = await pool.query<TaskRow>('SELECT id,title,starts_at,ends_at,completed,reminder_at FROM tasks WHERE user_id=$1 ORDER BY starts_at NULLS LAST,id', [res.locals.user.id]);
      res.json(result.rows.map(toPlannerTask));
    });
    async function findConflicts(db: pg.Pool | pg.PoolClient, userId: string, input: EventInput | TaskInput,
      kind: 'events' | 'tasks', id?: string) {
      const events = await db.query<EventRow>('SELECT id,title,starts_at,ends_at,all_day,hidden,reminder_at FROM events WHERE user_id=$1 AND starts_at<$3 AND ends_at>$2 AND ($4::uuid IS NULL OR id<>$4) ORDER BY starts_at,id',
        [userId, input.start, input.end, kind === 'events' ? id ?? null : null]);
      const tasks = await db.query<TaskRow>('SELECT id,title,starts_at,ends_at,completed,reminder_at FROM tasks WHERE user_id=$1 AND starts_at<$3 AND ends_at>$2 AND ($4::uuid IS NULL OR id<>$4) ORDER BY starts_at,id',
        [userId, input.start, input.end, kind === 'tasks' ? id ?? null : null]);
      return [...events.rows.map(toPlannerEvent), ...tasks.rows.map(toPlannerTask)];
    }
    // Read-only disclosure for users who check confirmation before their first save.
    // The subsequent write still rechecks under the account lock.
    app.post('/api/conflicts', async (req, res) => {
      const { kind, id, input } = req.body ?? {};
      if (!['events', 'tasks'].includes(kind) || (id !== undefined && (typeof id !== 'string' || !uuidPattern.test(id))) || !validEvent(input)) {
        res.status(400).json({ error: '請輸入有效的衝突查詢時段' }); return;
      }
      const conflicts = await findConflicts(pool, res.locals.user.id, input, kind, id);
      res.json(conflictResponse(req, res, input, conflicts,
        id ? 'PATCH' : 'POST', `/api/${kind}${id ? `/${id}` : ''}`));
    });
    app.post('/api/tasks', saveTask);
    app.patch('/api/tasks/:id', saveTask);
    async function saveTask(req: express.Request, res: express.Response) {
      const updating = req.method === 'PATCH';
      const id = updating ? String(req.params.id) : randomUUID();
      if (!uuidPattern.test(id)) { res.status(404).json({ error: '找不到待辦' }); return; }
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        res.status(400).json({ error: '請輸入有效待辦資料' }); return;
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [res.locals.user.id]);
        let previous: PlannerTask | undefined;
        if (updating) {
          const owned = await client.query<TaskRow>('SELECT id,title,starts_at,ends_at,completed,reminder_at FROM tasks WHERE id=$1 AND user_id=$2', [id, res.locals.user.id]);
          if (!owned.rows[0]) { await client.query('ROLLBACK'); res.status(404).json({ error: '找不到待辦' }); return; }
          previous = toPlannerTask(owned.rows[0]);
        }
        const patch: TaskPatch = req.body;
        const input: TaskInput = { ...previous, ...patch } as TaskInput;
        if (!validTask(input)) {
          await client.query('ROLLBACK'); res.status(400).json({ error: '請輸入待辦名稱；起訖皆留空或填入有效時間，結束須晚於開始' }); return;
        }
        // Completion alone must remain possible even for previously confirmed overlaps.
        if (input.start !== null && (!previous || 'start' in patch || 'end' in patch)) {
          const conflicts = await findConflicts(client, res.locals.user.id, input, 'tasks', id);
          if (needsConfirmation(req, res, input, conflicts)) {
            await client.query('ROLLBACK'); return;
          }
        }
        const result = updating
          ? await client.query<TaskRow>('UPDATE tasks SET title=$3,starts_at=$4,ends_at=$5,completed=$6,reminder_at=$7 WHERE id=$1 AND user_id=$2 RETURNING id,title,starts_at,ends_at,completed,reminder_at', [id, res.locals.user.id, input.title.trim(), input.start, input.end, input.completed ?? false, input.reminderAt ?? null])
          : await client.query<TaskRow>('INSERT INTO tasks(id,user_id,title,starts_at,ends_at,completed,reminder_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,title,starts_at,ends_at,completed,reminder_at', [id, res.locals.user.id, input.title.trim(), input.start, input.end, input.completed ?? false, input.reminderAt ?? null]);
        await client.query('COMMIT'); res.status(updating ? 200 : 201).json(toPlannerTask(result.rows[0]));
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    app.get('/api/events/:id', async (req, res) => {
      if (!uuidPattern.test(String(req.params.id))) { res.status(404).json({ error: '找不到行程' }); return; }
      const result = await pool.query<EventRow>('SELECT id,title,starts_at,ends_at,all_day,hidden,reminder_at FROM events WHERE id=$1 AND user_id=$2', [req.params.id, res.locals.user.id]);
      if (!result.rows[0]) { res.status(404).json({ error: '找不到行程' }); return; }
      res.json(toPlannerEvent(result.rows[0]));
    });
    app.post('/api/events', saveEvent);
    app.patch('/api/events/:id', saveEvent);
    async function saveEvent(req: express.Request, res: express.Response) {
      const updating = req.method === 'PATCH';
      const id = updating ? String(req.params.id) : randomUUID();
      if (!uuidPattern.test(id)) { res.status(404).json({ error: '找不到行程' }); return; }
      const client = await pool.connect();
      let previousHidden = false;
      let previousReminder: Date | null = null;
      try {
        await client.query('BEGIN');
        // Serialize writes per account; concurrent inserts cannot bypass conflict checks.
        await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [res.locals.user.id]);
        if (updating) {
          const owned = await client.query('SELECT id,hidden,reminder_at FROM events WHERE id=$1 AND user_id=$2', [id, res.locals.user.id]);
          previousHidden = owned.rows[0]?.hidden ?? false;
          previousReminder = owned.rows[0]?.reminder_at ?? null;
          if (!owned.rowCount) { await client.query('ROLLBACK'); res.status(404).json({ error: '找不到行程' }); return; }
        }
        if (!validEvent(req.body)) { await client.query('ROLLBACK'); res.status(400).json({ error: '請輸入名稱及有效的起訖時間，結束須晚於開始；全天起訖須為台北時間午夜' }); return; }
        const input: EventInput = req.body;
        const conflicts = await findConflicts(client, res.locals.user.id, input, 'events', id);
        if (needsConfirmation(req, res, input, conflicts)) {
          await client.query('ROLLBACK'); return;
        }
        const reminderAt = input.reminderAt === undefined ? previousReminder : input.reminderAt;
        const result = updating
          ? await client.query<EventRow>('UPDATE events SET title=$3,starts_at=$4,ends_at=$5,all_day=$6,hidden=$7,reminder_at=$8 WHERE id=$1 AND user_id=$2 RETURNING id,title,starts_at,ends_at,all_day,hidden,reminder_at', [id, res.locals.user.id, input.title.trim(), input.start, input.end, input.allDay ?? false, input.hidden ?? previousHidden, reminderAt])
          : await client.query<EventRow>('INSERT INTO events(id,user_id,title,starts_at,ends_at,all_day,hidden,reminder_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,title,starts_at,ends_at,all_day,hidden,reminder_at', [id, res.locals.user.id, input.title.trim(), input.start, input.end, input.allDay ?? false, input.hidden ?? previousHidden, reminderAt]);
        await client.query('COMMIT'); res.status(updating ? 200 : 201).json(toPlannerEvent(result.rows[0]));
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    app.delete('/api/events/:id', async (req, res) => {
      if (!uuidPattern.test(String(req.params.id))) { res.status(404).json({ error: '找不到行程' }); return; }
      const result = await pool.query('DELETE FROM events WHERE id=$1 AND user_id=$2', [req.params.id, res.locals.user.id]);
      res.status(result.rowCount ? 200 : 404).json(result.rowCount ? { ok: true } : { error: '找不到行程' });
    });
    app.use('/api', (_req, res) => { res.status(404).json({ error: '找不到 API' }); });
    app.get('/assets/app.js', (_req, res) => { res.type('js').send(js); });
    app.get('/assets/app.css', (_req, res) => { res.type('css').send(css); });
    app.get(['/', '/register', '/login'], (_req, res) => {
      res.type('html').send('<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Life Planner</title><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>');
    });
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = (error as { status?: number }).status;
      res.status(status === 400 || status === 413 ? status : 500).json({ error: status === 400 || status === 413 ? '請求格式錯誤' : '服務暫時無法使用' });
    });
    const server = app.listen(options.port ?? 0, options.host ?? '127.0.0.1');
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
    return { url: `http://${options.host ?? '127.0.0.1'}:${address.port}`, close: async () => {
      try { await new Promise<void>((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeAllConnections(); }); }
      finally { await pool.end(); }
    } };
  } catch (error) { await pool.end(); throw error; }
}
