import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { AccessRequest, Account, AdminAuditEvent, ChatAttachment, ChatConversation, ChatMessage, ChatParticipant, DailyWasteLog, Meal, MealAssignment, OrganizationNameChangeRequest, OrganizationType, Pickup, PublicAccountRole } from '@bloom/contracts';

export interface StoredAccount extends Account { passphraseHash: string }
export interface StoredSession { tokenHash: string; accountId: string; csrfHash: string; createdAt: string; expiresAt: string; lastActivityAt: string; revokedAt?: string }
export interface AccountToken { id: string; accountId: string; purpose: 'SETUP' | 'RESET' | 'VERIFY_EMAIL'; tokenHash: string; expiresAt: string; usedAt?: string; createdAt: string }
export interface EmailJob { id: string; to: string; subject: string; text: string; attempts: number; nextAttemptAt: string; createdAt: string; conversationId?: string; processingAt?: string; providerMessageId?: string; sentAt?: string; lastError?: string }
export interface Database {
  schemaVersion: 5;
  accounts: StoredAccount[];
  accessRequests: AccessRequest[];
  organizationNameRequests: OrganizationNameChangeRequest[];
  organizationTypes: OrganizationType[];
  auditEvents: AdminAuditEvent[];
  meals: Meal[];
  assignments: MealAssignment[];
  logs: DailyWasteLog[];
  pickups: Pickup[];
  sessions: StoredSession[];
  accountTokens: AccountToken[];
  chatConversations: ChatConversation[];
  chatParticipants: ChatParticipant[];
  chatMessages: ChatMessage[];
  chatAttachments: ChatAttachment[];
  emailJobs: EmailJob[];
}

export interface Repository {
  read(): Promise<Database>;
  mutate<T>(work: (database: Database) => T): Promise<T>;
}

export const hashPassphrase = (passphrase: string) => {
  const salt = randomBytes(16).toString('hex');
  return `scrypt-v1:${salt}:${scryptSync(passphrase, salt, 32).toString('hex')}`;
};

export const verifyPassphrase = (passphrase: string, stored: string) => {
  const parts = stored.split(':');
  const [salt, hash] = parts.length === 3 ? parts.slice(1) : parts;
  if (!salt || !hash) return false;
  const actual = scryptSync(passphrase, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const stamp = new Date().toISOString();
const today = stamp.slice(0, 10);
const typeSeeds: Array<[string, PublicAccountRole, string, number]> = [
  ['type-public-school', 'FOOD_WASTE_PRODUCER', 'Public school', 0],
  ['type-private-school', 'FOOD_WASTE_PRODUCER', 'Private school', 1],
  ['type-college', 'FOOD_WASTE_PRODUCER', 'College / University', 2],
  ['type-small-restaurant', 'FOOD_WASTE_PRODUCER', 'Small restaurant', 3],
  ['type-large-restaurant', 'FOOD_WASTE_PRODUCER', 'Large restaurant', 4],
  ['type-community-kitchen', 'FOOD_WASTE_PRODUCER', 'Community kitchen', 5],
  ['type-farmer', 'FOOD_COLLECTOR', 'Farmer / Livestock owner', 0],
  ['type-independent-collector', 'FOOD_COLLECTOR', 'Independent collector', 1],
  ['type-ngo-recovery', 'FOOD_COLLECTOR', 'NGO recovery service', 2],
  ['type-municipal-collector', 'FOOD_COLLECTOR', 'Municipal collector', 3],
  ['type-community-composter', 'FOOD_COLLECTOR', 'Community composter', 4],
  ['type-commercial-compost', 'FOOD_COLLECTOR', 'Commercial compost facility', 5],
  ['type-vermicompost', 'FOOD_COLLECTOR', 'Vermicompost facility', 6]
];
const builtInTypeIds = new Set(typeSeeds.map(([id]) => id));

export const seededOrganizationTypes = (): OrganizationType[] => typeSeeds.map(([id, role, name, sortOrder]) => ({ id, role, name, sortOrder, active: false, documentRequirements: [], createdAt: stamp, updatedAt: stamp }));

const seedDatabase = (): Database => {
  const providerId = 'acct-producer-demo';
  return {
    schemaVersion: 5,
    accounts: [
      { id: providerId, role: 'FOOD_WASTE_PRODUCER', accessCode: 'FWP-DEMO', passphraseHash: hashPassphrase('bloom-producer'), displayName: 'Ananya Rao', organizationName: 'Green Table Foods', contact: 'ananya@example.org', email: 'ananya@example.org', phone: '+919876543210', organizationTypeId: 'type-community-kitchen', status: 'ACTIVE', firstLogin: false, locality: 'Coimbatore', collectionAddress: '12 Service Road, Coimbatore, Tamil Nadu 641001', collectionInstructions: 'Use the service entrance and ask for the food operations lead.', createdAt: stamp },
      { id: 'acct-admin', role: 'ADMIN', accessCode: 'ADMIN-BLOOM', passphraseHash: hashPassphrase('bloom-admin'), displayName: 'Bloom Administrator', organizationName: 'Bloom Operations', contact: 'admin@example.org', email: 'admin@example.org', status: 'ACTIVE', firstLogin: false, createdAt: stamp }
    ],
    accessRequests: [],
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
    pickups: [],
    sessions: [],
    accountTokens: [],
    chatConversations: [],
    chatParticipants: [],
    chatMessages: [],
    chatAttachments: [],
    emailJobs: []
  };
};

const ensureLocalDemoAccounts = (database: Database) => {
  const localDemos: Array<Pick<StoredAccount, 'id' | 'role' | 'accessCode' | 'displayName' | 'organizationName' | 'contact' | 'email' | 'phone' | 'organizationTypeId' | 'locality' | 'collectionAddress' | 'collectionInstructions'> & { passphrase: string }> = [
    { id: 'acct-producer-demo', role: 'FOOD_WASTE_PRODUCER', accessCode: 'FWP-DEMO', passphrase: 'bloom-producer', displayName: 'Ananya Rao', organizationName: 'Green Table Foods', contact: 'ananya@example.org', email: 'ananya@example.org', phone: '+919876543210', organizationTypeId: 'type-community-kitchen', locality: 'Coimbatore', collectionAddress: '12 Service Road, Coimbatore, Tamil Nadu 641001', collectionInstructions: 'Use the service entrance and ask for the food operations lead.' },
    { id: 'acct-collector-demo', role: 'FOOD_COLLECTOR', accessCode: 'FCL-DEMO', passphrase: 'bloom-recovery', displayName: 'Karthik Mani', organizationName: 'Coimbatore Recovery Collective', contact: 'collector@example.org', email: 'collector@example.org', organizationTypeId: 'type-independent-collector' }
  ];
  for (const { passphrase, ...demo } of localDemos) if (!database.accounts.some((account) => account.id === demo.id || account.accessCode === demo.accessCode)) database.accounts.push({ ...demo, passphraseHash: hashPassphrase(passphrase), status: 'ACTIVE', firstLogin: false, createdAt: stamp });
};

export function normalizeDatabase(input: any): Database {
  const raw = input ?? {};
  const organizationTypes: OrganizationType[] = Array.isArray(raw.organizationTypes) && raw.organizationTypes.length
    ? raw.organizationTypes.map((item: any) => ({
        ...item,
        role: migratePublicRole(item.role),
        active: raw.schemaVersion >= 5 ? Boolean(item.active) : builtInTypeIds.has(item.id) ? false : Boolean(item.active),
        documentRequirements: Array.isArray(item.documentRequirements) ? item.documentRequirements : []
      }))
    : seededOrganizationTypes();
  const defaultType = (role: PublicAccountRole) => role === 'FOOD_WASTE_PRODUCER' ? 'type-community-kitchen' : 'type-independent-collector';
  const typeName = (id: string) => organizationTypes.find((type) => type.id === id)?.name ?? 'Organization';
  return {
    schemaVersion: 5,
    organizationTypes,
    auditEvents: Array.isArray(raw.auditEvents) ? raw.auditEvents : [],
    organizationNameRequests: Array.isArray(raw.organizationNameRequests) ? raw.organizationNameRequests : [],
    accounts: (raw.accounts ?? []).map((account: any) => {
      const role = account.role === 'ADMIN' ? 'ADMIN' : migratePublicRole(account.role);
      return {
        ...account,
        role,
        contact: account.contact ?? '',
        email: account.email ?? (String(account.contact ?? '').includes('@') ? account.contact : undefined),
        phone: account.phone ?? (!String(account.contact ?? '').includes('@') && account.contact ? account.contact : undefined),
        contactNeedsReview: account.contactNeedsReview ?? (!String(account.contact ?? '').includes('@')),
        status: account.status ?? 'ACTIVE',
        organizationTypeId: role === 'ADMIN' ? undefined : account.organizationTypeId ?? defaultType(role as PublicAccountRole),
        locality: role === 'FOOD_WASTE_PRODUCER' ? account.locality ?? '' : undefined,
        collectionAddress: role === 'FOOD_WASTE_PRODUCER' ? account.collectionAddress ?? '' : undefined,
        collectionInstructions: role === 'FOOD_WASTE_PRODUCER' ? account.collectionInstructions ?? '' : undefined
      };
    }),
    accessRequests: (raw.accessRequests ?? []).map((request: any) => {
      const role = migratePublicRole(request.role);
      const organizationTypeId = request.organizationTypeId ?? defaultType(role);
      const email = request.email ?? (String(request.contact ?? '').includes('@') ? request.contact : 'legacy@example.invalid');
      return {
        ...request,
        role,
        organizationTypeId,
        organizationTypeName: request.organizationTypeName ?? typeName(organizationTypeId),
        address: request.address ?? '',
        contact: email,
        email,
        whatsapp: request.whatsapp ?? request.phone ?? '',
        preferredContactMethod: request.preferredContactMethod ?? 'EMAIL',
        requiredDocuments: Array.isArray(request.requiredDocuments) ? request.requiredDocuments : [],
        documents: Array.isArray(request.documents) ? request.documents : [],
        submittedAt: request.submittedAt ?? (request.status === 'DRAFT' ? undefined : request.createdAt)
      };
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
        eligibleRoles: ['FOOD_COLLECTOR'],
        status: pickup.status === 'AWAITING_SCHOOL_CONFIRMATION' ? 'AWAITING_PROVIDER_CONFIRMATION' : pickup.status,
        availableFrom: pickup.availableFrom ?? pickup.createdAt,
        pickupDeadline: pickup.pickupDeadline ?? expiresAt ?? new Date(new Date(pickup.createdAt).getTime() + 12 * 60 * 60 * 1000).toISOString(),
        locality: pickup.locality ?? provider?.locality ?? '',
        collectionAddress: pickup.collectionAddress ?? provider?.collectionAddress ?? '',
        collectionInstructions: pickup.collectionInstructions ?? provider?.collectionInstructions ?? '',
        activity: Array.isArray(pickup.activity) ? pickup.activity : []
      };
    }),
    sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
    accountTokens: Array.isArray(raw.accountTokens) ? raw.accountTokens : [],
    chatConversations: Array.isArray(raw.chatConversations) ? raw.chatConversations : [],
    chatParticipants: Array.isArray(raw.chatParticipants) ? raw.chatParticipants : [],
    chatMessages: Array.isArray(raw.chatMessages) ? raw.chatMessages : [],
    chatAttachments: Array.isArray(raw.chatAttachments) ? raw.chatAttachments : [],
    emailJobs: Array.isArray(raw.emailJobs) ? raw.emailJobs : []
  };
}

function migratePublicRole(role: string): PublicAccountRole {
  return role === 'FARMER_COLLECTOR' || role === 'COMPOSTER' || role === 'FOOD_COLLECTOR'
    ? 'FOOD_COLLECTOR'
    : 'FOOD_WASTE_PRODUCER';
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
    ensureLocalDemoAccounts(database);
    if (raw.schemaVersion !== 5 || database.accounts.length !== (raw.accounts ?? []).length) await this.write(database);
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

  private readonly tables = {
    accounts: 'accounts', accessRequests: 'access_requests', organizationNameRequests: 'organization_name_requests', organizationTypes: 'organization_types',
    auditEvents: 'audit_events', meals: 'meals', assignments: 'meal_assignments', logs: 'waste_logs', pickups: 'pickups', sessions: 'sessions',
    accountTokens: 'account_tokens', chatConversations: 'chat_conversations', chatParticipants: 'chat_participants', chatMessages: 'chat_messages',
    chatAttachments: 'chat_attachments', emailJobs: 'email_jobs'
  } as const;

  private entityId(key: keyof typeof this.tables, entity: any) {
    if (key === 'sessions') return entity.tokenHash;
    if (key === 'chatParticipants') return `${entity.conversationId}:${entity.accountId}`;
    return entity.id;
  }

  private async readClient(client: PoolClient): Promise<Database> {
    const state = normalizeDatabase({ schemaVersion: 5, organizationTypes: [] });
    for (const [key, table] of Object.entries(this.tables) as Array<[keyof typeof this.tables, string]>) {
      const result = await client.query<{ document: unknown }>(`SELECT document FROM ${table} ORDER BY id`);
      (state[key] as unknown[]) = result.rows.map((row) => row.document);
    }
    return normalizeDatabase(state);
  }

  private async replaceAll(client: PoolClient, state: Database) {
    for (const [key, table] of Object.entries(this.tables) as Array<[keyof typeof this.tables, string]>) {
      await client.query(`DELETE FROM ${table}`);
      for (const entity of state[key] as unknown as any[]) await client.query(`INSERT INTO ${table} (id, document) VALUES ($1, $2::jsonb)`, [this.entityId(key, entity), JSON.stringify(entity)]);
    }
    await client.query(`INSERT INTO bloom_meta (key, value) VALUES ('schema_version', '5') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  }

  private verifyMigration(state: Database, expected?: Database) {
    const codes = state.accounts.map((account) => account.accessCode.toUpperCase());
    if (new Set(codes).size !== codes.length) throw new Error('Migration verification failed: duplicate access codes.');
    const accountIds = new Set(state.accounts.map((account) => account.id)); const logIds = new Set(state.logs.map((log) => log.id));
    if (state.meals.some((meal) => !accountIds.has(meal.providerId)) || state.assignments.some((assignment) => !accountIds.has(assignment.providerId)) || state.logs.some((log) => !accountIds.has(log.providerId))) throw new Error('Migration verification failed: provider ownership is incomplete.');
    if (state.pickups.some((pickup) => !accountIds.has(pickup.providerId) || !logIds.has(pickup.wasteLogId))) throw new Error('Migration verification failed: pickup references are incomplete.');
    if (expected && (state.accounts.length !== expected.accounts.length || state.pickups.length !== expected.pickups.length || state.logs.length !== expected.logs.length)) throw new Error('Migration verification failed: entity counts changed.');
  }

  async initialize() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(42656663);
        CREATE TABLE IF NOT EXISTS bloom_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, document JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS access_requests (id TEXT PRIMARY KEY, document JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS organization_name_requests (id TEXT PRIMARY KEY, document JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS organization_types (id TEXT PRIMARY KEY, document JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, document JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS meals (id TEXT PRIMARY KEY, document JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS meal_assignments (id TEXT PRIMARY KEY, document JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS waste_logs (id TEXT PRIMARY KEY, document JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS pickups (id TEXT PRIMARY KEY, document JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, document JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS account_tokens (id TEXT PRIMARY KEY, document JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS chat_conversations (id TEXT PRIMARY KEY, document JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS chat_participants (id TEXT PRIMARY KEY, document JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, document JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS chat_attachments (id TEXT PRIMARY KEY, document JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS email_jobs (id TEXT PRIMARY KEY, document JSONB NOT NULL);`);
      const version = await client.query(`SELECT value FROM bloom_meta WHERE key = 'schema_version'`);
      if (!version.rowCount) {
        const legacyTable = await client.query<{ name: string | null }>(`SELECT to_regclass('public.bloom_state')::text AS name`);
        let source: Database;
        if (legacyTable.rows[0]?.name) {
          const legacy = await client.query<{ document: unknown }>('SELECT document FROM bloom_state WHERE id = 1');
          source = legacy.rowCount ? normalizeDatabase(legacy.rows[0].document) : normalizeDatabase({ organizationTypes: seededOrganizationTypes() });
        } else source = normalizeDatabase({ organizationTypes: seededOrganizationTypes() });
        await this.replaceAll(client, source);
        this.verifyMigration(await this.readClient(client), source);
      } else if (version.rows[0]?.value !== '5') {
        const source = await this.readClient(client);
        await this.replaceAll(client, source);
        this.verifyMigration(await this.readClient(client), source);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async read() {
    const client = await this.pool.connect();
    try { await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); const state = await this.readClient(client); await client.query('COMMIT'); return state; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async mutate<T>(work: (database: Database) => T): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(42656663)');
      const database = await this.readClient(client);
      const value = work(database);
      await this.replaceAll(client, database);
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
  const prefix = role === 'FOOD_WASTE_PRODUCER' ? 'FWP' : 'FCL';
  let code = '';
  do { code = `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`; }
  while (accounts.some((account) => account.accessCode === code));
  return code;
};

export const createPassphrase = () => randomBytes(12).toString('base64url');
