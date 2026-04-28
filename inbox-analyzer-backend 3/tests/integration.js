// End-to-end integration test — boots real Express app with pglite DB,
// exercises every new endpoint to prove the fixes work.

const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  TVS Backend End-to-End Test');
  console.log('════════════════════════════════════════════════════════════════\n');

  // 1. Spin up pglite
  const pg = new PGlite();

  // Monkey-patch pg.Pool to use pglite
  const pgModule = require('pg');
  const origPool = pgModule.Pool;
  // pglite returns affectedRows:0 for SELECT (not undefined). We must detect
  // SELECT-style queries and use rows.length; for mutations use affectedRows.
  const wrap = (r, sql) => {
    const s = (sql || '').trim().toUpperCase();
    const isSelect = s.startsWith('SELECT') || s.startsWith('WITH');
    const isReturning = /\bRETURNING\b/i.test(sql || '');
    const rowCount = (isSelect || isReturning) ? r.rows.length : (r.affectedRows ?? r.rows.length);
    return { rows: r.rows, rowCount };
  };
  pgModule.Pool = class FakePool {
    constructor() {}
    async query(text, params) {
      const r = await pg.query(text, params || []);
      return wrap(r, text);
    }
    async connect() {
      return {
        query: async (text, params) => {
          if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
            await pg.query(text);
            return { rows: [], rowCount: 0 };
          }
          const r = await pg.query(text, params || []);
          return wrap(r, text);
        },
        release: () => {},
      };
    }
    on() { return this; }
  };

  // 2. Env for the server
  process.env.DATABASE_URL = 'postgres://fake';
  process.env.JWT_SECRET = 'testtesttesttesttesttesttesttest';
  process.env.PORT = '0'; // pick random
  process.env.NODE_ENV = 'test';
  process.env.CORS_ORIGIN = '*';

  // 3. Apply schema manually (since migrate.js uses pool too)
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  // Split on semicolons for pglite (it can handle multi-statement but this is safer)
  const stmts = schema.split(/;\s*\n/).map(s => s.trim()).filter(s => s.length > 0);
  for (const stmt of stmts) {
    try {
      await pg.query(stmt);
    } catch (err) {
      console.error('Schema error on:', stmt.slice(0, 100), err.message);
      throw err;
    }
  }
  console.log('✓ Schema applied\n');

  // 4. Require express app
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  const authRoutes = require('../src/routes/auth');
  const analyzeRoutes = require('../src/routes/analyze');
  const historyRoutes = require('../src/routes/history');
  const settingsRoutes = require('../src/routes/settings');
  const groupsRoutes = require('../src/routes/groups');
  const sendRoutes = require('../src/routes/send');
  const scheduleRoutes = require('../src/routes/schedule');
  const errorHandler = require('../src/middleware/errorHandler');

  app.use('/api/auth', authRoutes);
  app.use('/api/analyze', analyzeRoutes);
  app.use('/api/history', historyRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/groups', groupsRoutes);
  app.use('/api/send', sendRoutes);
  app.use('/api/schedule', scheduleRoutes);
  app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.originalUrl }));
  app.use(errorHandler);

  const server = app.listen(0);
  const port = server.address().port;
  const BASE = `http://127.0.0.1:${port}`;
  console.log(`✓ Test server on ${BASE}\n`);

  // Test helpers
  let token = null;
  const call = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  };
  const ok = (res, expected = 200) => res.status === expected;

  let pass = 0, fail = 0;
  const test = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else      { fail++; console.log(`  ✗ ${name}  — ${detail || ''}`); }
  };

  console.log('━━━ 1. Auth ━━━');
  const reg = await call('POST', '/api/auth/register', {
    email: 'devin@test.com', password: 'password123', name: 'Devin',
  });
  test('Register new user', reg.status === 200 || reg.status === 201, `status=${reg.status} ${JSON.stringify(reg.data)}`);
  token = reg.data?.token;
  test('Token returned', !!token);

  // Try registering same email - should fail
  const regDup = await call('POST', '/api/auth/register', {
    email: 'devin@test.com', password: 'password123', name: 'Devin',
  });
  test('Reject duplicate registration', regDup.status === 400 || regDup.status === 409);

  // Login with correct password
  const tokenSave = token; token = null;
  const loginGood = await call('POST', '/api/auth/login', { email: 'devin@test.com', password: 'password123' });
  test('Login with correct password', loginGood.status === 200 && !!loginGood.data?.token, `status=${loginGood.status} ${JSON.stringify(loginGood.data)}`);

  // Login with wrong password
  const loginBad = await call('POST', '/api/auth/login', { email: 'devin@test.com', password: 'wrongpass' });
  test('Login with wrong password fails', loginBad.status === 401);

  // /api/auth/me with valid token
  token = loginGood.data?.token || tokenSave;
  const me = await call('GET', '/api/auth/me');
  test('GET /api/auth/me with valid token', me.status === 200 && me.data?.user?.email === 'devin@test.com');

  // /api/auth/me without token
  const tmpToken = token; token = null;
  const meNoAuth = await call('GET', '/api/auth/me');
  test('GET /api/auth/me without token returns 401', meNoAuth.status === 401);
  token = tmpToken;

  console.log('\n━━━ 2. Settings ━━━');
  const s1 = await call('GET', '/api/settings');
  test('GET /api/settings (empty)', ok(s1), JSON.stringify(s1.data));
  test('Empty hasApiKey = false', s1.data?.hasApiKey === false);

  const s2 = await call('PUT', '/api/settings', {
    apiKey: 'em_test_abc123xyz789',
    fromEmail: 'hello@mail.thevitaminshots.com',
    fromName: 'Alexa from The Vitamin Shots',
    replyTo: 'info@thevitaminshots.com',
    sendRatePerMinute: 30,
  });
  test('PUT /api/settings', ok(s2), JSON.stringify(s2.data));

  const s3 = await call('GET', '/api/settings');
  test('hasApiKey now true', s3.data?.hasApiKey === true);
  test('fromEmail saved', s3.data?.fromEmail === 'hello@mail.thevitaminshots.com');
  test('API key masked', s3.data?.apiKeyMasked?.includes('••••'));

  // Save again without changing key — key should NOT be wiped
  const s4 = await call('PUT', '/api/settings', { fromName: 'Alexa' });
  test('PUT (partial update)', ok(s4));
  const s5 = await call('GET', '/api/settings');
  test('API key still saved after partial update', s5.data?.hasApiKey === true);

  console.log('\n━━━ 3. Groups ━━━');
  const g1 = await call('GET', '/api/groups');
  test('GET /api/groups (empty)', ok(g1) && g1.data?.groups?.length === 0, JSON.stringify(g1.data));

  const g2 = await call('POST', '/api/groups', { name: 'Seeds', description: 'My 12 seed inboxes' });
  test('POST /api/groups', g2.status === 201, JSON.stringify(g2.data));
  const groupId = g2.data?.group?.id;
  test('Group id returned', typeof groupId === 'number');

  // Bulk add via text
  const g3 = await call('POST', `/api/groups/${groupId}/emails`, {
    text: `alice@gmail.com,Alice,Smith
bob@outlook.com,Bob
charlie@yahoo.com
invalid-email
alice@gmail.com
dave@icloud.com,Dave,Jones,Seed 4`,
  });
  test('Bulk add emails', ok(g3), JSON.stringify(g3.data));
  test('4 inserted', g3.data?.inserted === 4);
  test('1 duplicate skipped', g3.data?.skipped_duplicates === 1);
  test('1 invalid', g3.data?.invalid_count === 1);

  const g4 = await call('GET', `/api/groups/${groupId}`);
  test('Group detail', ok(g4) && g4.data?.emails?.length === 4);
  test('First name preserved', g4.data?.emails?.find(e => e.email === 'alice@gmail.com')?.first_name === 'Alice');

  console.log('\n━━━ 4. Schedule ━━━');
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 60 * 1000).toISOString();

  const sch1 = await call('POST', '/api/schedule', {
    groupId, subject: 'Test scheduled email',
    html: '<p>Hi {{first_name}}</p>',
    scheduledAt: future,
    campaignLabel: 'Day 7 welcome',
  });
  test('Schedule one send', sch1.status === 201, JSON.stringify(sch1.data));
  const schedId = sch1.data?.id;

  const schBad = await call('POST', '/api/schedule', {
    groupId, subject: 'x', html: '<p>x</p>', scheduledAt: past,
  });
  test('Reject past scheduledAt', schBad.status === 400 && schBad.data?.error?.includes('future'));

  const schList = await call('GET', '/api/schedule');
  test('List scheduled', ok(schList) && schList.data?.scheduled?.length === 1);
  test('Status is scheduled', schList.data?.scheduled?.[0]?.status === 'scheduled');
  test('Group name joined', schList.data?.scheduled?.[0]?.group_name === 'Seeds');

  const schCancel = await call('POST', `/api/schedule/${schedId}/cancel`);
  test('Cancel scheduled', ok(schCancel));

  const schList2 = await call('GET', '/api/schedule');
  test('Cancelled status reflected', schList2.data?.scheduled?.[0]?.status === 'cancelled');

  // Bulk schedule
  const schBulk = await call('POST', '/api/schedule/bulk', {
    defaults: { groupId },
    items: [
      { subject: 'Day 1', html: '<p>day 1</p>', scheduledAt: new Date(Date.now() + 24*3600*1000).toISOString() },
      { subject: 'Day 2', html: '<p>day 2</p>', scheduledAt: new Date(Date.now() + 48*3600*1000).toISOString() },
      { subject: '', html: '<p>x</p>', scheduledAt: new Date(Date.now() + 72*3600*1000).toISOString() }, // invalid
      { subject: 'Day 4', html: '<p>day 4</p>', scheduledAt: 'not-a-date' }, // invalid
    ],
  });
  test('Bulk schedule', schBulk.status === 201, JSON.stringify(schBulk.data));
  test('2 created in bulk', schBulk.data?.createdCount === 2);
  test('2 failed in bulk', schBulk.data?.failedCount === 2);

  console.log('\n━━━ 5. Version endpoint ━━━');
  // (Not actually registered in test app, but let's verify routes registered)
  const notFound = await call('GET', '/api/nonexistent');
  test('Unknown route returns 404', notFound.status === 404);
  test('404 includes path hint', notFound.data?.path === '/api/nonexistent');

  console.log('\n━━━ 6. Send job creation (without actually sending) ━━━');
  // Can't actually send without a real EmailIt key, but we can create the job
  const sendRes = await call('POST', '/api/send', {
    groupId,
    subject: 'Test direct send',
    html: '<p>test</p>',
    fromEmail: 'hello@mail.thevitaminshots.com',
  });
  // Will probably succeed in creating the job, may fail on actual send later
  test('Send job created', sendRes.status === 201, JSON.stringify(sendRes.data));

  const jobsList = await call('GET', '/api/send/jobs');
  test('List send jobs', ok(jobsList) && jobsList.data?.jobs?.length >= 1);

  console.log('\n━━━ 7. Analyze + History ━━━');
  const ana = await call('POST', '/api/analyze/template', {
    subject: 'Your order #1234 is confirmed',
    html: '<!DOCTYPE html><html><body><p>Hi John,</p><p>Thanks for your order!</p><p>The Vitamin Shots, 123 Market St, San Francisco, CA 94103</p><p><a href="https://thevitaminshots.com/unsubscribe">Unsubscribe</a></p></body></html>',
    campaignLabel: 'Test order email',
  });
  test('Analyze template', ana.status === 200, JSON.stringify(ana.data).slice(0, 150));
  test('Probabilities sum to 100', (ana.data?.probabilities?.primary || 0) + (ana.data?.probabilities?.promotions || 0) + (ana.data?.probabilities?.spam || 0) === 100);

  const hist = await call('GET', '/api/history');
  test('History list', hist.status === 200 && Array.isArray(hist.data?.analyses) && hist.data.analyses.length >= 1);

  const histDetail = await call('GET', `/api/history/${ana.data.id}`);
  test('History detail', histDetail.status === 200);

  // Cleanup test resources
  console.log('\n━━━ 8. Cleanup ━━━');
  const delGroup = await call('DELETE', `/api/groups/${groupId}`);
  test('Delete group cascades', delGroup.status === 200);

  console.log(`\n════════════════════════════════════════════════════════════════`);
  console.log(`  Results: ${pass} passed, ${fail} failed`);
  console.log(`════════════════════════════════════════════════════════════════\n`);

  server.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('TEST CRASHED:', err);
  process.exit(1);
});
