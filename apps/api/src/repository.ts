import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import type { AccessRequest, Account, DailyWasteLog, Meal, MealAssignment, Pickup } from '@bloom/contracts';

export interface StoredAccount extends Account { passphraseHash: string }
export interface Database {
  accounts: StoredAccount[];
  accessRequests: AccessRequest[];
  meals: Meal[];
  assignments: MealAssignment[];
  logs: DailyWasteLog[];
  pickups: Pickup[];
}

export interface Repository {
  read(): Promise<Database>;
  mutate<T>(work: (database: Database) => T): Promise<T>;
}

export const hashPassphrase = (passphrase: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(passphrase, salt, 32).toString('hex')}`;
};

export const verifyPassphrase = (passphrase: string, stored: string) => {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const actual = scryptSync(passphrase, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const today = new Date().toISOString().slice(0, 10);
const seedDatabase = (): Database => {
  const schoolId = 'acct-school-demo';
  return {
    accounts: [
      { id: schoolId, role: 'SCHOOL', accessCode: 'SCH-DEMO', passphraseHash: hashPassphrase('bloom-school'), displayName: 'Ananya Rao', organizationName: 'Coimbatore Government School', firstLogin: false, createdAt: new Date().toISOString() },
      { id: 'acct-admin', role: 'ADMIN', accessCode: 'ADMIN-BLOOM', passphraseHash: hashPassphrase('bloom-admin'), displayName: 'District Administrator', organizationName: 'Coimbatore Food Recovery Office', firstLogin: false, createdAt: new Date().toISOString() }
    ],
    accessRequests: [
      { id: 'request-demo', applicantName: 'Maya Krishnan', role: 'SCHOOL', organizationName: 'Pudur Municipal School', contact: 'maya@example.org', note: 'We serve 240 lunches each weekday.', status: 'PENDING', createdAt: new Date().toISOString() }
    ],
    meals: [
      { id: 'meal-tomato', schoolId, name: 'Tomato rice with pepper egg', createdAt: new Date().toISOString() },
      { id: 'meal-sambar', schoolId, name: 'Sambar rice and boiled egg', createdAt: new Date().toISOString() },
      { id: 'meal-biryani', schoolId, name: 'Vegetable biryani', createdAt: new Date().toISOString() }
    ],
    assignments: [{ id: 'assign-today', schoolId, date: today, mealIds: ['meal-tomato'], recurrence: { frequency: 'NONE' }, createdAt: new Date().toISOString() }],
    logs: [],
    pickups: []
  };
};

export class FileRepository implements Repository {
  private queue = Promise.resolve();
  constructor(private readonly filePath = resolve(process.cwd(), 'data/dev.json')) {}

  private async ensure() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try { await readFile(this.filePath, 'utf8'); }
    catch { await this.write(seedDatabase()); }
  }

  private async write(database: Database) {
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, JSON.stringify(database, null, 2));
    await rename(temp, this.filePath);
  }

  async read() {
    await this.ensure();
    return JSON.parse(await readFile(this.filePath, 'utf8')) as Database;
  }

  async mutate<T>(work: (database: Database) => T): Promise<T> {
    let result!: T;
    this.queue = this.queue.then(async () => {
      const database = await this.read();
      result = work(database);
      await this.write(database);
    });
    await this.queue;
    return result;
  }
}

export class PostgresRepository implements Repository {
  private readonly pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS bloom_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        document JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO bloom_state (id, document) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING;
    `, [JSON.stringify(seedDatabase())]);
  }

  async read() {
    const result = await this.pool.query<{ document: Database }>('SELECT document FROM bloom_state WHERE id = 1');
    return result.rows[0].document;
  }

  async mutate<T>(work: (database: Database) => T): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ document: Database }>('SELECT document FROM bloom_state WHERE id = 1 FOR UPDATE');
      const database = result.rows[0].document;
      const value = work(database);
      await client.query('UPDATE bloom_state SET document = $1::jsonb, updated_at = NOW() WHERE id = 1', [JSON.stringify(database)]);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}

export async function createRepository(): Promise<Repository> {
  const driver = process.env.DATA_DRIVER;
  if (driver === 'file') return new FileRepository();
  if (driver === 'postgres') {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when DATA_DRIVER=postgres');
    const repository = new PostgresRepository(process.env.DATABASE_URL);
    await repository.initialize();
    return repository;
  }
  throw new Error('Set DATA_DRIVER explicitly to file or postgres.');
}

export const createAccessCode = (role: string, accounts: StoredAccount[]) => {
  const prefix = role === 'SCHOOL' ? 'SCH' : role === 'COMPOSTER' ? 'CMP' : 'FAR';
  let value = '';
  do { value = `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`; }
  while (accounts.some((account) => account.accessCode === value));
  return value;
};

export const createPassphrase = () => randomBytes(9).toString('base64url');
export { randomUUID };
