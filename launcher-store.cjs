const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.DATABASE_URL ? undefined : '/var/run/postgresql',
  database: process.env.PGDATABASE || 'egt_arcade',
  user: process.env.PGUSER || 'root',
  max: 10,
});

async function initStorage(fallbackState) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS balance_ledger (
      id text PRIMARY KEY,
      instance_id text NOT NULL,
      user_id text NOT NULL,
      username text NOT NULL,
      actor_user_id text NOT NULL,
      actor_username text NOT NULL,
      amount numeric(20,2) NOT NULL,
      balance_before numeric(20,2) NOT NULL CHECK (balance_before >= 0),
      balance_after numeric(20,2) NOT NULL CHECK (balance_after >= 0),
      reason text NOT NULL,
      reference text,
      reversal_of text REFERENCES balance_ledger(id),
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS balance_ledger_instance_created_idx ON balance_ledger(instance_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS balance_ledger_user_created_idx ON balance_ledger(user_id, created_at DESC);
    ALTER TABLE balance_ledger ALTER COLUMN amount TYPE numeric(20,2) USING amount::numeric(20,2);
    ALTER TABLE balance_ledger ALTER COLUMN balance_before TYPE numeric(20,2) USING balance_before::numeric(20,2);
    ALTER TABLE balance_ledger ALTER COLUMN balance_after TYPE numeric(20,2) USING balance_after::numeric(20,2);
    CREATE TABLE IF NOT EXISTS error_reports (
      id bigserial PRIMARY KEY,
      level text NOT NULL,
      source text NOT NULL,
      message text NOT NULL,
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS error_reports_created_idx ON error_reports(created_at DESC);
    CREATE TABLE IF NOT EXISTS update_checks (
      id bigserial PRIMARY KEY,
      status text NOT NULL,
      previous_hash text,
      current_hash text,
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY,
      username text NOT NULL UNIQUE,
      nickname text NOT NULL,
      role text NOT NULL CHECK (role IN ('admin','player')),
      is_root boolean NOT NULL DEFAULT false,
      currency text NOT NULL CHECK (currency IN ('RON','EUR','GBP')),
      password_salt text NOT NULL,
      password_hash text NOT NULL,
      created_at timestamptz NOT NULL
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions jsonb NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_admin_id text REFERENCES users(id);
    CREATE TABLE IF NOT EXISTS instances (
      id text PRIMARY KEY,
      name text NOT NULL,
      owner_user_id text NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL,
      cleared_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS memberships (
      instance_id text NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES users(id),
      balance numeric(20,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
      wallet_sequence bigint NOT NULL DEFAULT 0,
      PRIMARY KEY(instance_id,user_id)
    );
    ALTER TABLE memberships ADD COLUMN IF NOT EXISTS access_active boolean NOT NULL DEFAULT false;
    ALTER TABLE memberships ADD COLUMN IF NOT EXISTS last_active_at timestamptz;
    CREATE TABLE IF NOT EXISTS instance_activity (
      id text PRIMARY KEY,
      instance_id text NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      occurred_at timestamptz NOT NULL,
      actor_user_id text NOT NULL,
      actor_username text NOT NULL,
      event_type text NOT NULL,
      details jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS instance_activity_instance_at_idx ON instance_activity(instance_id,occurred_at DESC);
    CREATE TABLE IF NOT EXISTS catalog_games (
      game_key text PRIMARY KEY,
      title text NOT NULL,
      category text NOT NULL,
      enabled boolean NOT NULL,
      accent text NOT NULL,
      tone text NOT NULL,
      icon text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS system_audit (
      id text PRIMARY KEY,
      occurred_at timestamptz NOT NULL,
      actor_user_id text NOT NULL,
      actor_username text NOT NULL,
      event_type text NOT NULL,
      details jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS system_audit_at_idx ON system_audit(occurred_at DESC);
    CREATE TABLE IF NOT EXISTS importer_jobs (
      id text PRIMARY KEY,
      data jsonb NOT NULL,
      status text NOT NULL,
      position bigint GENERATED BY DEFAULT AS IDENTITY,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS importer_jobs_status_position_idx ON importer_jobs(status,position);
    CREATE TABLE IF NOT EXISTS app_sessions (
      token_hash text PRIMARY KEY,
      user_id text NOT NULL,
      csrf text NOT NULL,
      active_game_currency text NOT NULL DEFAULT 'RON',
      expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE app_sessions ALTER COLUMN expires_at DROP NOT NULL;
    UPDATE app_sessions SET expires_at=NULL;
    CREATE INDEX IF NOT EXISTS app_sessions_expires_idx ON app_sessions(expires_at);
    ALTER TABLE app_sessions ADD COLUMN IF NOT EXISTS admin_authorized_until timestamptz;
    CREATE TABLE IF NOT EXISTS game_bridges (
      token_hash text PRIMARY KEY,
      session_user_id text NOT NULL,
      wallet_user_id text NOT NULL,
      currency text NOT NULL,
      instance_id text NOT NULL,
      game_key text NOT NULL,
      upstream_balance numeric(20,2),
      last_sequence bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS game_bridges_updated_idx ON game_bridges(updated_at);
    ALTER TABLE balance_ledger ADD COLUMN IF NOT EXISTS wallet_sequence bigint;
    ALTER TABLE balance_ledger ADD COLUMN IF NOT EXISTS recorded_order bigserial;
    CREATE UNIQUE INDEX IF NOT EXISTS balance_ledger_wallet_sequence_idx ON balance_ledger(instance_id,user_id,wallet_sequence) WHERE wallet_sequence IS NOT NULL;
    CREATE OR REPLACE FUNCTION prevent_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'balance_ledger is append-only'; END;
    $$;
    DROP TRIGGER IF EXISTS balance_ledger_append_only ON balance_ledger;
    CREATE TRIGGER balance_ledger_append_only BEFORE UPDATE OR DELETE ON balance_ledger
      FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
  `);
  const existing = await pool.query('SELECT data FROM app_state WHERE singleton=true');
  if (existing.rowCount) {
    await migrateRelational(existing.rows[0].data);
    return loadRelationalState();
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO app_state(singleton,data) VALUES(true,$1::jsonb)', [JSON.stringify(fallbackState)]);
    for (const instance of fallbackState.instances || []) {
      for (const member of instance.members || []) {
        if (!member.balance) continue;
        const user = (fallbackState.users || []).find(item => item.id === member.userId);
        await client.query(`INSERT INTO balance_ledger
          (id,instance_id,user_id,username,actor_user_id,actor_username,amount,balance_before,balance_after,reason,details)
          VALUES($1,$2,$3,$4,$5,$6,$7,0,$7,'MIGRATED_OPENING_BALANCE',$8::jsonb)`,
          [`txn_migration_${instance.id}_${member.userId}`, instance.id, member.userId, user?.username || 'unknown', 'system', 'system', member.balance, JSON.stringify({ source: 'launcher-auth.json' })]);
      }
    }
    await client.query('COMMIT');
    await migrateRelational(fallbackState);
    return loadRelationalState();
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function syncRelationalState(state, client, options = {}) {
  for (const user of state.users || []) await client.query(`INSERT INTO users(id,username,nickname,role,is_root,currency,password_salt,password_hash,created_at,permissions,tenant_admin_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) ON CONFLICT(id) DO UPDATE SET username=excluded.username,nickname=excluded.nickname,role=excluded.role,is_root=excluded.is_root,currency=excluded.currency,password_salt=excluded.password_salt,password_hash=excluded.password_hash,permissions=excluded.permissions,tenant_admin_id=excluded.tenant_admin_id`,
    [user.id,user.username,user.nickname||user.username,user.role,Boolean(user.root),user.currency||'RON',user.passwordSalt,user.passwordHash,user.createdAt,JSON.stringify(user.permissions||{}),user.tenantAdminId||null]);
  for (const instance of state.instances || []) {
    await client.query(`INSERT INTO instances(id,name,owner_user_id,created_at,cleared_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,owner_user_id=excluded.owner_user_id,cleared_at=excluded.cleared_at`,[instance.id,instance.name,instance.ownerUserId,instance.createdAt,instance.clearedAt||null]);
    for (const member of instance.members || []) await client.query(`INSERT INTO memberships(instance_id,user_id,balance,access_active,last_active_at) VALUES($1,$2,CASE WHEN $6 THEN 0::numeric ELSE $3::numeric END,$4,$5) ON CONFLICT(instance_id,user_id) DO UPDATE SET balance=CASE WHEN $6 THEN memberships.balance ELSE excluded.balance END,access_active=excluded.access_active,last_active_at=excluded.last_active_at`,[instance.id,member.userId,member.balance,Boolean(member.accessActive),member.lastActiveAt||null,Boolean(options.preserveBalances)]);
    await client.query('DELETE FROM memberships WHERE instance_id=$1 AND NOT (user_id=ANY($2::text[]))',[instance.id,(instance.members||[]).map(member=>member.userId)]);
    for (const event of instance.activity || []) await client.query(`INSERT INTO instance_activity(id,instance_id,occurred_at,actor_user_id,actor_username,event_type,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(id) DO NOTHING`,[event.id,instance.id,event.at,event.actorUserId,event.actorUsername,event.type,JSON.stringify(event.details||{})]);
    const activityIds=(instance.activity||[]).map(event=>event.id); await client.query('DELETE FROM instance_activity WHERE instance_id=$1 AND NOT (id=ANY($2::text[]))',[instance.id,activityIds]);
  }
  await client.query('DELETE FROM instances WHERE NOT (id=ANY($1::text[]))',[(state.instances||[]).map(instance=>instance.id)]);
  await client.query('DELETE FROM users WHERE NOT (id=ANY($1::text[]))',[(state.users||[]).map(user=>user.id)]);
  for (const game of state.catalog || []) await client.query(`INSERT INTO catalog_games(game_key,title,category,enabled,accent,tone,icon,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(game_key) DO UPDATE SET title=excluded.title,category=excluded.category,enabled=excluded.enabled,accent=excluded.accent,tone=excluded.tone,icon=excluded.icon,updated_at=excluded.updated_at`,[game.key,game.title,game.category||'Other',game.enabled!==false,game.accent||'',game.tone||'',game.icon||'',game.createdAt||new Date().toISOString(),game.updatedAt||new Date().toISOString()]);
  await client.query('DELETE FROM catalog_games WHERE NOT (game_key=ANY($1::text[]))',[(state.catalog||[]).map(game=>game.key)]);
  await client.query('INSERT INTO app_settings(singleton,data) VALUES(true,$1::jsonb) ON CONFLICT(singleton) DO UPDATE SET data=excluded.data,updated_at=now()',[JSON.stringify(state.settings||{})]);
  for (const event of state.systemAudit || []) await client.query(`INSERT INTO system_audit(id,occurred_at,actor_user_id,actor_username,event_type,details) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(id) DO NOTHING`,[event.id,event.at,event.actorUserId,event.actorUsername,event.type,JSON.stringify(event.details||{})]);
  await client.query('DELETE FROM system_audit WHERE NOT (id=ANY($1::text[]))',[(state.systemAudit||[]).map(event=>event.id)]);
}

async function migrateRelational(state) {
  const count = await pool.query('SELECT count(*)::int AS count FROM users');
  if (count.rows[0].count) return;
  const client = await pool.connect(); try { await client.query('BEGIN'); await syncRelationalState(state,client); await client.query('COMMIT'); } catch(error){await client.query('ROLLBACK');throw error} finally{client.release()}
}

async function loadRelationalState() {
  const [users,instances,members,activity,catalog,settings,audit,mirror] = await Promise.all([
    pool.query(`SELECT id,username,nickname,role,is_root AS root,currency,password_salt AS "passwordSalt",password_hash AS "passwordHash",created_at AS "createdAt",permissions,tenant_admin_id AS "tenantAdminId" FROM users ORDER BY created_at`),
    pool.query(`SELECT id,name,owner_user_id AS "ownerUserId",created_at AS "createdAt",cleared_at AS "clearedAt" FROM instances ORDER BY created_at`),
    pool.query(`SELECT instance_id AS "instanceId",user_id AS "userId",balance::text,access_active AS "accessActive",last_active_at AS "lastActiveAt" FROM memberships`),
    pool.query(`SELECT id,instance_id AS "instanceId",occurred_at AS at,actor_user_id AS "actorUserId",actor_username AS "actorUsername",event_type AS type,details FROM instance_activity ORDER BY occurred_at`),
    pool.query(`SELECT game_key AS key,title,category,enabled,accent,tone,icon,created_at AS "createdAt",updated_at AS "updatedAt" FROM catalog_games ORDER BY created_at`),
    pool.query('SELECT data FROM app_settings WHERE singleton=true'), pool.query(`SELECT id,occurred_at AS at,actor_user_id AS "actorUserId",actor_username AS "actorUsername",event_type AS type,details FROM system_audit ORDER BY occurred_at`), pool.query('SELECT data FROM app_state WHERE singleton=true')]);
  const result={version:3,users:users.rows,instances:instances.rows.map(i=>({...i,members:members.rows.filter(m=>m.instanceId===i.id).map(m=>({userId:m.userId,balance:Number(m.balance),accessActive:m.accessActive,lastActiveAt:m.lastActiveAt})),activity:activity.rows.filter(a=>a.instanceId===i.id).map(({instanceId,...a})=>a)})),catalog:catalog.rows,settings:settings.rows[0]?.data||{},systemAudit:audit.rows};
  return {...(mirror.rows[0]?.data||{}),...result};
}

async function saveState(state, client = pool) {
  if (client === pool) { const tx=await pool.connect(); try{await tx.query('BEGIN');await syncRelationalState(state,tx);await tx.query('UPDATE app_state SET data=$1::jsonb,updated_at=now() WHERE singleton=true',[JSON.stringify(state)]);await tx.query('COMMIT')}catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()} }
  else { await syncRelationalState(state,client); await client.query('UPDATE app_state SET data=$1::jsonb,updated_at=now() WHERE singleton=true',[JSON.stringify(state)]); }
}

async function saveStateWithLedger(state, entries) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await syncRelationalState(state,client,{preserveBalances:true});
    for (const entry of entries) {
      const wallet=await client.query('SELECT balance::text,wallet_sequence FROM memberships WHERE instance_id=$1 AND user_id=$2 FOR UPDATE',[entry.instanceId,entry.userId]);
      if(!wallet.rowCount) throw new Error(`Wallet membership missing for ${entry.instanceId}:${entry.userId}`);
      if(Number(wallet.rows[0].balance)!==Number(entry.balanceBefore)) throw new Error(`Concurrent wallet balance conflict for ${entry.instanceId}:${entry.userId}`);
      const sequence=Number(wallet.rows[0].wallet_sequence)+1;
      await client.query(`INSERT INTO balance_ledger
        (id,instance_id,user_id,username,actor_user_id,actor_username,amount,balance_before,balance_after,reason,reference,reversal_of,details,created_at,wallet_sequence)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,COALESCE($14::timestamptz,clock_timestamp()),$15)`,
        [entry.id,entry.instanceId,entry.userId,entry.username,entry.actorUserId,entry.actorUsername,entry.amount,entry.balanceBefore,entry.balanceAfter,entry.reason,entry.reference||null,entry.reversalOf||null,JSON.stringify(entry.details||{}),entry.createdAt||null,sequence]);
      await client.query('UPDATE memberships SET balance=$3,wallet_sequence=$4 WHERE instance_id=$1 AND user_id=$2',[entry.instanceId,entry.userId,entry.balanceAfter,sequence]);
    }
    await client.query('UPDATE app_state SET data=$1::jsonb,updated_at=now() WHERE singleton=true',[JSON.stringify(state)]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function saveGameSettlements(state, entries) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const entry of entries) {
      const wallet = await client.query('SELECT balance::text,wallet_sequence FROM memberships WHERE instance_id=$1 AND user_id=$2 FOR UPDATE', [entry.instanceId, entry.userId]);
      if (!wallet.rowCount) throw new Error(`Wallet membership missing for ${entry.instanceId}:${entry.userId}`);
      if (Number(wallet.rows[0].balance) !== Number(entry.balanceBefore)) throw new Error(`Concurrent wallet balance conflict for ${entry.instanceId}:${entry.userId}`);
      const sequence = Number(wallet.rows[0].wallet_sequence) + 1;
      await client.query(`INSERT INTO balance_ledger
        (id,instance_id,user_id,username,actor_user_id,actor_username,amount,balance_before,balance_after,reason,reference,reversal_of,details,created_at,wallet_sequence)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,COALESCE($14::timestamptz,clock_timestamp()),$15)`,
        [entry.id,entry.instanceId,entry.userId,entry.username,entry.actorUserId,entry.actorUsername,entry.amount,entry.balanceBefore,entry.balanceAfter,entry.reason,entry.reference||null,entry.reversalOf||null,JSON.stringify(entry.details||{}),entry.createdAt||null,sequence]);
      await client.query('UPDATE memberships SET balance=$3,wallet_sequence=$4 WHERE instance_id=$1 AND user_id=$2', [entry.instanceId,entry.userId,entry.balanceAfter,sequence]);
      const instance = (state.instances || []).find(item => item.id === entry.instanceId);
      const event = instance?.activity?.find(item => item.details?.transactionId === entry.id);
      if (event) await client.query(`INSERT INTO instance_activity(id,instance_id,occurred_at,actor_user_id,actor_username,event_type,details)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(id) DO NOTHING`, [event.id,entry.instanceId,event.at,event.actorUserId,event.actorUsername,event.type,JSON.stringify(event.details||{})]);
    }
    await client.query('UPDATE app_settings SET data=$1::jsonb,updated_at=now() WHERE singleton=true', [JSON.stringify(state.settings || {})]);
    await client.query('UPDATE app_state SET data=$1::jsonb,updated_at=now() WHERE singleton=true', [JSON.stringify(state)]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function listLedger(instanceId, options = {}) {
  const values = [instanceId]; const where = ['instance_id=$1'];
  if (options.since) { values.push(options.since); where.push(`created_at>$${values.length}`); }
  if (options.userId) { values.push(options.userId); where.push(`user_id=$${values.length}`); }
  if (options.reason) { values.push(options.reason); where.push(`reason=$${values.length}`); }
  values.push(Math.min(50000, Math.max(1, Number(options.limit) || 200)));
  const result = await pool.query(`SELECT id,instance_id AS "instanceId",user_id AS "userId",username,actor_username AS "actorUsername",
    amount::text,balance_before::text AS "balanceBefore",balance_after::text AS "balanceAfter",reason,reference,reversal_of AS "reversalOf",details,created_at AS "createdAt"
    FROM balance_ledger WHERE ${where.join(' AND ')} ORDER BY recorded_order DESC LIMIT $${values.length}`, values);
  return result.rows.map(row => ({ ...row, amount: Number(row.amount), balanceBefore: Number(row.balanceBefore), balanceAfter: Number(row.balanceAfter) }));
}

async function recordError(level, source, message, details = {}) {
  await pool.query('INSERT INTO error_reports(level,source,message,details) VALUES($1,$2,$3,$4::jsonb)', [level, source, String(message).slice(0, 2000), JSON.stringify(details)]);
}

async function monitoringSnapshot(instanceIds = null) {
  const [database, errors, ledger] = await Promise.all([
    pool.query('SELECT updated_at AS "stateUpdatedAt",pg_database_size(current_database())::text AS bytes FROM app_state WHERE singleton=true'),
    instanceIds ? Promise.resolve({rows:[]}) : pool.query('SELECT id,level,source,message,details,created_at AS "createdAt" FROM error_reports ORDER BY created_at DESC LIMIT 100'),
    instanceIds ? pool.query('SELECT count(*)::int AS count FROM balance_ledger WHERE instance_id=ANY($1::text[])',[instanceIds]) : pool.query('SELECT count(*)::int AS count FROM balance_ledger'),
  ]);
  return { database: { ...database.rows[0], bytes: Number(database.rows[0]?.bytes || 0) }, errors: errors.rows, ledgerEntries: ledger.rows[0].count };
}

async function recordUpdateCheck(status, previousHash, currentHash, details = {}) {
  await pool.query('INSERT INTO update_checks(status,previous_hash,current_hash,details) VALUES($1,$2,$3,$4::jsonb)', [status, previousHash || null, currentHash || null, JSON.stringify(details)]);
}

async function recentUpdateChecks(limit = 30) {
  const result = await pool.query('SELECT id,status,previous_hash AS "previousHash",current_hash AS "currentHash",details,created_at AS "createdAt" FROM update_checks ORDER BY created_at DESC LIMIT $1', [limit]);
  return result.rows;
}

async function saveImporterJob(job) { await pool.query(`INSERT INTO importer_jobs(id,data,status,updated_at) VALUES($1,$2::jsonb,$3,now()) ON CONFLICT(id) DO UPDATE SET data=excluded.data,status=excluded.status,updated_at=now()`,[job.id,JSON.stringify(job),job.status]); }
async function loadImporterJobs() { const r=await pool.query(`SELECT data FROM importer_jobs WHERE created_at>now()-interval '30 days' ORDER BY position`);return r.rows.map(x=>x.data); }
async function pruneOperationalData() { await pool.query(`DELETE FROM error_reports WHERE created_at<now()-interval '90 days';DELETE FROM update_checks WHERE created_at<now()-interval '365 days';DELETE FROM importer_jobs WHERE updated_at<now()-interval '30 days' AND status IN ('complete','failed')`); }

async function saveSession(tokenHash, session) {
  await pool.query(`INSERT INTO app_sessions(token_hash,user_id,csrf,active_game_currency,expires_at,admin_authorized_until)
    VALUES($1,$2,$3,$4,CASE WHEN $5::double precision IS NULL THEN NULL ELSE to_timestamp($5 / 1000.0) END,CASE WHEN $6::double precision IS NULL THEN NULL ELSE to_timestamp($6 / 1000.0) END)
    ON CONFLICT(token_hash) DO UPDATE SET user_id=excluded.user_id,csrf=excluded.csrf,active_game_currency=excluded.active_game_currency,expires_at=excluded.expires_at,admin_authorized_until=excluded.admin_authorized_until`,
    [tokenHash, session.userId, session.csrf, session.activeGameCurrency || 'RON', session.expiresAt, session.adminAuthorizedUntil || null]);
}

async function loadSessions() {
  const result = await pool.query(`SELECT token_hash AS "tokenHash",user_id AS "userId",csrf,active_game_currency AS "activeGameCurrency",
    extract(epoch from expires_at)*1000 AS "expiresAt",extract(epoch from admin_authorized_until)*1000 AS "adminAuthorizedUntil" FROM app_sessions WHERE expires_at IS NULL OR expires_at>now()`);
  return result.rows.map(row => ({ ...row, expiresAt: row.expiresAt===null?null:Number(row.expiresAt),adminAuthorizedUntil:row.adminAuthorizedUntil?Number(row.adminAuthorizedUntil):null }));
}

async function deleteSession(tokenHash) { await pool.query('DELETE FROM app_sessions WHERE token_hash=$1', [tokenHash]); }
async function pruneSessions() { await pool.query('DELETE FROM app_sessions WHERE expires_at IS NOT NULL AND expires_at<=now()'); }

async function saveGameBridge(tokenHash, bridge) {
  await pool.query(`INSERT INTO game_bridges(token_hash,session_user_id,wallet_user_id,currency,instance_id,game_key,upstream_balance,last_sequence,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9 / 1000.0))
    ON CONFLICT(token_hash) DO UPDATE SET upstream_balance=excluded.upstream_balance,last_sequence=excluded.last_sequence,updated_at=excluded.updated_at`,
    [tokenHash, bridge.sessionUserId, bridge.walletUserId, bridge.currency, bridge.instanceId, bridge.gameKey, bridge.upstreamBalance, bridge.lastSequence, bridge.updatedAt]);
}

async function loadGameBridges() {
  const result = await pool.query(`SELECT token_hash AS "tokenHash",session_user_id AS "sessionUserId",wallet_user_id AS "walletUserId",currency,instance_id AS "instanceId",game_key AS "gameKey",
    upstream_balance::text AS "upstreamBalance",last_sequence::text AS "lastSequence",extract(epoch from updated_at)*1000 AS "updatedAt" FROM game_bridges`);
  return result.rows.map(row => ({ ...row, upstreamBalance: row.upstreamBalance===null?null:Number(row.upstreamBalance), lastSequence: Number(row.lastSequence), updatedAt: Number(row.updatedAt), queue: Promise.resolve() }));
}

async function pruneGameBridges() { /* Durable until explicitly revoked. */ }

module.exports = { initStorage, saveState, saveStateWithLedger, saveGameSettlements, listLedger, recordError, monitoringSnapshot, recordUpdateCheck, recentUpdateChecks, saveSession, loadSessions, deleteSession, pruneSessions, saveGameBridge, loadGameBridges, pruneGameBridges, saveImporterJob, loadImporterJobs, pruneOperationalData, pool };
