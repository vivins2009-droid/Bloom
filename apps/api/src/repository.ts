import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import type { AccessRequest, Account, AdminAuditEvent, DailyWasteLog, Meal, MealAssignment, OrganizationNameChangeRequest, OrganizationType, Pickup, PublicAccountRole } from '@bloom/contracts';

export interface StoredAccount extends Account { passphraseHash: string }
export interface Database {
  schemaVersion: 3;
  accounts: StoredAccount[];
  accessRequests: AccessRequest[];
  organizationNameRequests: OrganizationNameChangeRequest[];
  organizationTypes: OrganizationType[];
  auditEvents: AdminAuditEvent[];
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

const stamp = new Date().toISOString();
const today = stamp.slice(0, 10);
const typeSeeds: Array<[string, PublicAccountRole, string, number]> = [
  ['type-public-school', 'FOOD_PROVIDER', 'Public school', 0],
  ['type-private-school', 'FOOD_PROVIDER', 'Private school', 1],
  ['type-college', 'FOOD_PROVIDER', 'College / University', 2],
  ['type-small-restaurant', 'FOOD_PROVIDER', 'Small restaurant', 3],
  ['type-large-restaurant', 'FOOD_PROVIDER', 'Large restaurant', 4],
  ['type-community-kitchen', 'FOOD_PROVIDER', 'Community kitchen', 5],
  ['type-farmer', 'FARMER_COLLECTOR', 'Farmer / Livestock owner', 0],
  ['type-independent-collector', 'FARMER_COLLECTOR', 'Independent collector', 1],
  ['type-ngo-recovery', 'FARMER_COLLECTOR', 'NGO recovery service', 2],
  ['type-municipal-collector', 'FARMER_COLLECTOR', 'Municipal collector', 3],
  ['type-community-composter', 'COMPOSTER', 'Community composter', 0],
  ['type-commercial-compost', 'COMPOSTER', 'Commercial compost facility', 1],
  ['type-vermicompost', 'COMPOSTER', 'Vermicompost facility', 2]
];

export const seededOrganizationTypes = (): OrganizationType[] => typeSeeds.map(([id, role, name, sortOrder]) => ({ id, role, name, sortOrder, active: true, createdAt: stamp, updatedAt: stamp }));

const seedDatabase = (): Database => {
  const providerId = 'acct-school-demo';
  return {
    schemaVersion: 3,
    accounts: [
      { id: providerId, role: 'FOOD_PROVIDER', accessCode: 'SCH-DEMO', passphraseHash: hashPassphrase('bloom-school'), displayName: 'Ananya Rao', organizationName: 'Coimbatore Government School', contact: 'ananya@example.org', organizationTypeId: 'type-public-school', status: 'ACTIVE', firstLogin: false, locality: 'Coimbatore', collectionAddress: '12 School Road, Coimbatore, Tamil Nadu 641001', collectionInstructions: 'Use the kitchen service entrance and ask for the food service lead.', createdAt: stamp },
      { id: 'acct-admin', role: 'ADMIN', accessCode: 'ADMIN-BLOOM', passphraseHash: hashPassphrase('bloom-admin'), displayName: 'District Administrator', organizationName: 'Coimbatore Food Recovery Office', contact: 'admin@example.org', status: 'ACTIVE', firstLogin: false, createdAt: stamp }
    ],
    accessRequests: [
      { id: 'request-demo', applicantName: 'Maya Krishnan', role: 'FOOD_PROVIDER', organizationTypeId: 'type-public-school', organizationTypeName: 'Public school', organizationName: 'Pudur Municipal School', contact: 'maya@example.org', note: 'We serve 240 lunches each weekday.', status: 'PENDING', createdAt: stamp }
    ],
    organizationNameRequests: [],
    organizationTypes: seededOrganizationTypes(),
    auditEvents: [],
    meals: [
      { id: 'meal-tomato', providerId, name: 'Tomato rice with pepper egg', createdAt: stamp },
      { id: 'meal-sambar', providerId, name: 'Sambar rice and boiled egg', createdAt: stamp },
      { id: 'meal-biryani', providerId, name: 'Vegetable biryani', createdAt: stamp }
    ],
    assignments: [{ id: 'assign-today', providerId, date: today, mealIds: ['meal-tomato'], recurrence: { frequency: 'NONE' }, createdAt: stamp }],
    logs: [],
    pickups: []
  };
};

const ensureLocalRecoveryDemos = (database: Database) => {
  const localDemos: Array<Pick<StoredAccount, 'id' | 'role' | 'accessCode' | 'displayName' | 'organizationName' | 'contact' | 'organizationTypeId'>> = [
    { id: 'acct-farmer-demo', role: 'FARMER_COLLECTOR', accessCode: 'FCL-DEMO', displayName: 'Karthik Mani', organizationName: 'Coimbatore Recovery Collective', contact: 'collector@example.org', organizationTypeId: 'type-independent-collector' },
    { id: 'acct-composter-demo', role: 'COMPOSTER', accessCode: 'CMP-DEMO', displayName: 'Meera Das', organizationName: 'Noyyal Community Compost', contact: 'compost@example.org', organizationTypeId: 'type-community-composter' }
  ];
  for (const demo of localDemos) if (!database.accounts.some((account) => account.id === demo.id || account.accessCode === demo.accessCode)) database.accounts.push({ ...demo, passphraseHash: hashPassphrase('bloom-recovery'), status: 'ACTIVE', firstLogin: false, createdAt: stamp });
};

export function normalizeDatabase(input: any): Database {
  const raw = input ?? {};
  const organizationTypes: OrganizationType[] = Array.isArray(raw.organizationTypes) && raw.organizationTypes.length
    ? raw.organizationTypes.map((item: any) => ({ ...item, role: item.role === 'SCHOOL' ? 'FOOD_PROVIDER' : item.role }))
    : seededOrganizationTypes();
  const migrateRole = (role: string) => role === 'SCHOOL' ? 'FOOD_PROVIDER' : role;
  const defaultType = (role: PublicAccountRole) => role === 'FOOD_PROVIDER' ? 'type-public-school' : role === 'FARMER_COLLECTOR' ? 'type-independent-collector' : 'type-community-composter';
  const typeName = (id: string) => organizationTypes.find((type) => type.id === id)?.name ?? 'Organization';
  return {
    schemaVersion: 3,
    organizationTypes,
    auditEvents: Array.isArray(raw.auditEvents) ? raw.auditEvents : [],
    organizationNameRequests: Array.isArray(raw.organizationNameRequests) ? raw.organizationNameRequests : [],
    accounts: (raw.accounts ?? []).map((account: any) => {
      const role = migrateRole(account.role) as Account['role'];
      return {
        ...account,
        role,
        contact: account.contact ?? '',
        status: account.status ?? 'ACTIVE',
        organizationTypeId: role === 'ADMIN' ? undefined : account.organizationTypeId ?? defaultType(role as PublicAccountRole),
        locality: role === 'FOOD_PROVIDER' ? account.locality ?? '' : undefined,
        collectionAddress: role === 'FOOD_PROVIDER' ? account.collectionAddress ?? '' : undefined,
        collectionInstructions: role === 'FOOD_PROVIDER' ? account.collectionInstructions ?? '' : undefined
      };
    }),
    accessRequests: (raw.accessRequests ?? []).map((request: any) => {
      const role = migrateRole(request.role) as PublicAccountRole;
      const organizationTypeId = request.organizationTypeId ?? defaultType(role);
      return { ...request, role, organizationTypeId, organizationTypeName: request.organizationTypeName ?? typeName(organizationTypeId) };
    }),
    meals: (raw.meals ?? []).map(({ schoolId, ...meal }: any) => ({ ...meal, providerId: meal.providerId ?? schoolId })),
    assignments: (raw.assignments ?? []).map(({ schoolId, ...assignment }: any) => ({ ...assignment, providerId: assignment.providerId ?? schoolId })),
    logs: (raw.logs ?? []).map(({ schoolId, ...log }: any) => ({ ...log, providerId: log.providerId ?? schoolId })),
    pickups: (raw.pickups ?? []).map(({ schoolId, destination: _destination, expiresAt, ...pickup }: any) => {
      const providerId = pickup.providerId ?? schoolId;
      const provider = (raw.accounts ?? []).find((account: any) => account.id === providerId);
      return {
        ...pickup,
        providerId,
        providerName: pickup.providerName ?? provider?.organizationName ?? 'Food Provider',
        eligibleRoles: pickup.eligibleRoles?.length ? pickup.eligibleRoles : ['FARMER_COLLECTOR', 'COMPOSTER'],
        status: pickup.status === 'AWAITING_SCHOOL_CONFIRMATION' ? 'AWAITING_PROVIDER_CONFIRMATION' : pickup.status,
        availableFrom: pickup.availableFrom ?? pickup.createdAt,
        pickupDeadline: pickup.pickupDeadline ?? expiresAt ?? new Date(new Date(pickup.createdAt).getTime() + 12 * 60 * 60 * 1000).toISOString(),
        locality: pickup.locality ?? provider?.locality ?? '',
        collectionAddress: pickup.collectionAddress ?? provider?.collectionAddress ?? '',
        collectionInstructions: pickup.collectionInstructions ?? provider?.collectionInstructions ?? '',
        activity: Array.isArray(pickup.activity) ? pickup.activity : []
      };
    })
  };
}

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
    const raw = JSON.parse(await readFile(this.filePath, 'utf8'));
    const database = normalizeDatabase(raw);
    ensureLocalRecoveryDemos(database);
    if (raw.schemaVersion !== 3 || database.accounts.length !== (raw.accounts ?? []).length) await this.write(database);
    return database;
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
  constructor(connectionString: string) { this.pool = new Pool({ connectionString }); }

  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS bloom_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        document JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO bloom_state (id, document) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING;
    `, [JSON.stringify(seedDatabase())]);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ document: unknown }>('SELECT document FROM bloom_state WHERE id = 1 FOR UPDATE');
      const raw = result.rows[0].document as any;
      if (raw.schemaVersion !== 3) await client.query('UPDATE bloom_state SET document = $1::jsonb, updated_at = NOW() WHERE id = 1', [JSON.stringify(normalizeDatabase(raw))]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async read() {
    const result = await this.pool.query<{ document: Database }>('SELECT document FROM bloom_state WHERE id = 1');
    return normalizeDatabase(result.rows[0].document);
  }

  async mutate<T>(work: (database: Database) => T): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ document: Database }>('SELECT document FROM bloom_state WHERE id = 1 FOR UPDATE');
      const database = normalizeDatabase(result.rows[0].document);
      const value = work(database);
      await client.query('UPDATE bloom_state SET document = $1::jsonb, updated_at = NOW() WHERE id = 1', [JSON.stringify(database)]);
      await client.query('COMMIT');
      return value;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}

export async function createRepository(): Promise<Repository> {
  const driver = process.env.DATA_DRIVER;
  if (driver === 'file') return new FileRepository(process.env.DATA_FILE ? resolve(process.env.DATA_FILE) : undefined);
  if (driver === 'postgres') {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    const repository = new PostgresRepository(process.env.DATABASE_URL);
    await repository.initialize();
    return repository;
  }
  throw new Error('DATA_DRIVER must be explicitly set to file or postgres.');
}

export const createAccessCode = (role: PublicAccountRole, accounts: StoredAccount[]) => {
  const prefix = role === 'FOOD_PROVIDER' ? 'FPR' : role === 'COMPOSTER' ? 'CMP' : 'FCL';
  let code = '';
  do { code = `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`; }
  while (accounts.some((account) => account.accessCode === code));
  return code;
};

export const createPassphrase = () => randomBytes(12).toString('base64url');
