import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cachedRows, institutionDate, openCache, purge, synchronize} from './sync.js';

const date = '2026-11-27';
const owner = ['project-a', 'teacher-a'];
const names = ['usage_logs'];
const first = '2026-11-27T01:00:00.000001Z';
const second = '2026-11-27T01:00:00.000002Z';
const third = '2026-11-27T01:00:00.000003Z';
const record = (id, updated_at, fields = {}) => ({
  id, updated_at, class_code: 'A', report_date: date, student_name: 'Student',
  deleted_at: null, ...fields,
});

test('cache uses the institution date across midnight', () => {
  assert.equal(institutionDate(new Date('2026-11-26T18:29:59Z')), '2026-11-26');
  assert.equal(institutionDate(new Date('2026-11-26T18:30:00Z')), date);
});

test('scoped initial sync, cached reopening, changes, tombstones and atomic retry', async () => {
  const db = openCache();
  const pages = [];
  let rows = [record('a', first), record('b', first),
    record('c', first, {report_date: '2026-11-26'}), record('d', first, {class_code: 'B'})];
  let upper = first;
  let failAfterPage = false;
  const source = {
    watermark: async () => upper,
    page: async (query) => {
      const {cursor, classCode, date: reportDate, upper, pageSize} = query;
      pages.push(query);
      if (failAfterPage && cursor?.[1] === 'e') throw new Error('Connection lost');
      return rows.filter((row) => row.class_code === classCode && row.report_date === reportDate
        && row.updated_at <= upper && (!cursor || row.updated_at > cursor[0]
          || (row.updated_at === cursor[0] && row.id > cursor[1])))
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id))
        .slice(0, pageSize);
    },
  };
  const sync = (initialOnly) => synchronize({db, owner, classes: ['A'], date, names, initialOnly, source, pageSize: 1});
  const read = (identity = owner) => cachedRows(db, 'usage_logs', identity, ['A'], date);
  try {
    assert.deepEqual((await sync(true)).counts, {added: 2, updated: 0, deleted: 0});
    assert.deepEqual((await read()).map((row) => row.id), ['a', 'b']);
    assert.ok(pages.every((query) => query.date === date && query.classCode === 'A'));
    const requestsBeforeReopening = pages.length;
    assert.equal(await sync(true), null);
    assert.equal(pages.length, requestsBeforeReopening);
    assert.deepEqual(await read(['project-a', 'teacher-b']), []);
    assert.deepEqual(await read(['project-b', 'teacher-a']), []);

    upper = second;
    rows = [record('a', second, {student_name: 'Updated'}),
      record('b', second, {deleted_at: second}), record('e', second), record('f', third)];
    failAfterPage = true;
    await assert.rejects(sync(false), /Connection lost/);
    assert.deepEqual((await read()).map((row) => row.student_name), ['Student', 'Student']);

    failAfterPage = false;
    assert.deepEqual((await sync(false)).counts, {added: 1, updated: 1, deleted: 1});
    assert.deepEqual((await read()).map((row) => [row.id, row.student_name]), [['a', 'Updated'], ['e', 'Student']]);
    upper = third;
    assert.deepEqual((await sync(false)).counts, {added: 1, updated: 0, deleted: 0});
    assert.deepEqual((await sync(false)).counts, {added: 0, updated: 0, deleted: 0});
    await purge(db, owner, () => true, '2000-01-01T00:00:00Z');
    assert.equal((await read()).length, 3);
    await purge(db, owner, () => true, '2099-01-01T00:00:00Z');
    assert.deepEqual(await read(), []);
    await sync(true);
    await purge(db, owner, (row) => row.class_code === 'B');
    assert.deepEqual(await read(), []);
    assert.equal(await db.sync_metadata.count(), 0);
  } finally {
    await db.delete();
  }
});
