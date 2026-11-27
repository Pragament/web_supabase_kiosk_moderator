import Dexie from 'dexie';

const scopeIndex = '[project+teacher+class_code+report_date]';
const primary = '[project+teacher+id]';
const metaPrimary = '[project+teacher+class_code+report_date+stream]';
const scopeFields = 'id,class_code,report_date,updated_at,deleted_at';
const details = 'student_id,app_name,process_name,pc_name,timestamp';
export const columns = {
  usage_logs: `${scopeFields},${details},student_name,usage_duration_seconds`,
  pc_activity_logs: `${scopeFields},${details},action`,
  daily_summary: `${scopeFields},student_id,student_name,app_name,process_name,total_usage_seconds,total_open_count,total_blocked_count`,
};
const streams = Object.keys(columns);
const lastId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

export function openCache() {
  const db = new Dexie('TeacherDashboardDB');
  const eventIndexes = `${primary}, ${scopeIndex}, [project+teacher], student_id, timestamp, updated_at`;
  db.version(1).stores({
    usage_logs: eventIndexes,
    pc_activity_logs: eventIndexes,
    daily_summary: `${primary}, ${scopeIndex}, [project+teacher], student_id, updated_at`,
    sync_metadata: `${metaPrimary}, [project+teacher]`,
  });
  return db;
}

export function institutionDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export async function purge(db, owner, keep, cutoff) {
  const tables = [...streams, 'sync_metadata'].map((name) => db.table(name));
  await db.transaction('rw', tables, async () => {
    if (!keep) {
      for (const table of tables) await table.where('[project+teacher]').equals(owner).delete();
      return;
    }
    const stale = await db.sync_metadata.where('[project+teacher]').equals(owner)
      .filter((row) => !keep(row) || (cutoff && row.syncedAt < cutoff)).toArray();
    for (const {class_code, report_date, stream} of stale) {
      const scope = [...owner, class_code, report_date];
      await db.table(stream).where(scopeIndex).equals(scope).delete();
      await db.sync_metadata.delete([...scope, stream]);
    }
  });
}

export async function cachedRows(db, name, owner, classes, date) {
  if (!classes.length) return [];
  return db.table(name).where(scopeIndex).anyOf(classes.map((code) => [...owner, code, date])).toArray();
}

export function readMetadata(db, owner, classes, date, names) {
  return db.sync_metadata.bulkGet(names.flatMap((name) =>
    classes.map((code) => [...owner, code, date, name])));
}

export async function synchronize({db, owner, classes, date, names, initialOnly, source,
  validate = async () => {}, pageSize = 500}) {
  const jobs = [];
  const meta = await readMetadata(db, owner, classes, date, names);
  for (const name of names) {
    for (const code of classes) {
      const previous = meta.shift();
      if (!initialOnly || !previous) jobs.push({name, code, previous, rows: []});
    }
  }
  if (!jobs.length) return null;
  const upper = await source.watermark();
  if (!upper) throw new Error('Reporting access is unavailable.');
  for (const job of jobs) {
    let cursor = job.previous?.cursor;
    for (;;) {
      const page = await source.page({name: job.name, classCode: job.code, date, cursor, upper, pageSize});
      job.rows.push(...page);
      if (!page.length) break;
      const last = page.at(-1);
      cursor = [last.updated_at, last.id];
    }
  }
  await validate();
  const [project, teacher] = owner;
  const counts = {added: 0, updated: 0, deleted: 0};
  const syncedAt = new Date().toISOString();
  await db.transaction('rw', db.sync_metadata, ...names.map((name) => db.table(name)), async () => {
    for (const {name, code, previous, rows} of jobs) {
      const key = [...owner, code, date, name];
      const latest = await db.sync_metadata.get(key);
      if (JSON.stringify(latest?.cursor) !== JSON.stringify(previous?.cursor)) {
        throw new Error('Another tab synchronized this view. Try again.');
      }
      const table = db.table(name);
      const keys = rows.map(({id}) => [...owner, id]);
      const existing = await table.bulkGet(keys);
      const upserts = [];
      const deletes = [];
      for (const [index, row] of rows.entries()) {
        if (row.class_code !== code || row.report_date !== date) throw new Error('Unexpected report scope.');
        if (row.deleted_at) {
          if (existing[index]) counts.deleted++;
          deletes.push(keys[index]);
        } else {
          counts[existing[index] ? 'updated' : 'added']++;
          upserts.push({...row, project, teacher});
        }
      }
      await table.bulkPut(upserts);
      await table.bulkDelete(deletes);
      await db.sync_metadata.put({
        project, teacher, class_code: code, report_date: date, stream: name,
        cursor: [upper, lastId], syncedAt,
      });
    }
  });
  return {counts, syncedAt};
}

export function supabaseSource(client, signal) {
  async function unwrap(query) {
    const {data, error} = await query.abortSignal(signal);
    if (error) throw new Error(error.message);
    return data;
  }
  return {
    watermark: () => unwrap(client.rpc('kiosk_reporting_watermark')),
    page({name, classCode, date, cursor, upper, pageSize}) {
      let query = client.from(name).select(columns[name]).eq('class_code', classCode).eq('report_date', date)
        .lte('updated_at', upper).order('updated_at').order('id').limit(pageSize);
      if (cursor) {
        const [stamp, id] = cursor;
        query = query.or(`updated_at.gt."${stamp}",and(updated_at.eq."${stamp}",id.gt.${id})`);
      }
      return unwrap(query);
    },
  };
}
