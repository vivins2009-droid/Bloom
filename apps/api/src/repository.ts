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
  findSessionAccount(tokenHash: string): Promise<{ session: StoredSession; account: StoredAccount } | null>;
  refreshSession(tokenHash: string, csrfHash: string, lastActivityAt: string): Promise<void>;
}

type EntityCollectionKey = Exclude<keyof Database, 'schemaVersion'>;

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

const presentationDatabase = (): Database => {
  const database = seedDatabase();
  const now = Date.now();
  const iso = (offsetDays: number, hour = 10) => {
    const date = new Date(now + offsetDays * 86400000);
    date.setHours(hour, 0, 0, 0);
    return date.toISOString();
  };
  const date = (offsetDays: number) => iso(offsetDays).slice(0, 10);
  const providerId = 'acct-producer-demo';
  const collectorId = 'acct-collector-demo';
  const secondProviderId = 'acct-provider-sunrise';

  database.accounts = [
    ...database.accounts,
    { id: secondProviderId, role: 'FOOD_WASTE_PRODUCER', accessCode: 'FWP-SUNRISE', passphraseHash: hashPassphrase('bloom-sunrise'), displayName: 'Meera Krishnan', organizationName: 'Sunrise Public School', contact: 'meera@sunriseschool.org', email: 'meera@sunriseschool.org', phone: '+919812345678', organizationTypeId: 'type-private-school', status: 'ACTIVE', firstLogin: false, locality: 'Coimbatore', collectionAddress: '45 Lake View Road, Coimbatore, Tamil Nadu 641018', collectionInstructions: 'Use the rear kitchen gate beside the staff parking area.', createdAt: iso(-18) }
  ];
  database.organizationTypes = database.organizationTypes.map((type) => ({ ...type, active: ['type-private-school', 'type-college', 'type-small-restaurant', 'type-large-restaurant', 'type-community-kitchen', 'type-independent-collector', 'type-ngo-recovery', 'type-community-composter'].includes(type.id) }));

  database.meals = [
    { id: 'meal-tomato', providerId, name: 'Tomato rice with pepper egg', createdAt: iso(-30) },
    { id: 'meal-sambar', providerId, name: 'Sambar rice and boiled egg', createdAt: iso(-30) },
    { id: 'meal-biryani', providerId, name: 'Vegetable biryani', createdAt: iso(-24) },
    { id: 'meal-lemon', providerId, name: 'Lemon rice and vegetable korma', createdAt: iso(-16) },
    { id: 'meal-pulao', providerId: secondProviderId, name: 'Vegetable pulao', createdAt: iso(-16) },
    { id: 'meal-chapati', providerId: secondProviderId, name: 'Chapati and chana masala', createdAt: iso(-12) }
  ];
  database.assignments = [
    { id: 'assign-today', providerId, date: date(0), mealIds: ['meal-tomato'], recurrence: { frequency: 'NONE' }, createdAt: iso(-2) },
    { id: 'assign-tomorrow', providerId, date: date(1), mealIds: ['meal-sambar'], recurrence: { frequency: 'NONE' }, createdAt: iso(-2) },
    { id: 'assign-friday', providerId, date: date(3), mealIds: ['meal-biryani'], recurrence: { frequency: 'NONE' }, createdAt: iso(-2) },
    { id: 'assign-school-today', providerId: secondProviderId, date: date(0), mealIds: ['meal-pulao'], recurrence: { frequency: 'NONE' }, createdAt: iso(-5) },
    { id: 'assign-school-next', providerId: secondProviderId, date: date(2), mealIds: ['meal-chapati'], recurrence: { frequency: 'NONE' }, createdAt: iso(-5) }
  ];
  const log = (id: string, owner: string, daysAgo: number, mealIds: string[], leftoverKg: number, attendance: number, prepared: number, category: string, reason: DailyWasteLog['reason'], suitableForCollection: boolean) => ({ id, providerId: owner, date: date(-daysAgo), mealIds, actualAttendance: attendance, servingsPrepared: prepared, recordedAt: iso(-daysAgo, 14), servicePeriod: 'LUNCH' as const, wasteStage: 'OVERPRODUCTION' as const, foodCategory: category, leftoverKg, reason, suitableForCollection, notes: suitableForCollection ? 'Packed in clean, labelled containers and ready for collection.' : 'Used for staff meal and compost segregation.', createdAt: iso(-daysAgo, 14) });
  database.logs = [
    log('log-1', providerId, 1, ['meal-tomato'], 7.4, 182, 205, 'Rice', 'OVERPRODUCTION', true),
    log('log-2', providerId, 3, ['meal-sambar'], 5.2, 176, 190, 'Rice', 'OVERPRODUCTION', true),
    log('log-3', providerId, 5, ['meal-biryani'], 3.8, 168, 178, 'Mixed meal', 'OVERPRODUCTION', true),
    log('log-4', providerId, 7, ['meal-lemon'], 6.1, 180, 195, 'Rice', 'OVERPRODUCTION', true),
    log('log-5', providerId, 9, ['meal-tomato'], 4.5, 171, 182, 'Rice', 'OVERPRODUCTION', true),
    log('log-6', providerId, 12, ['meal-sambar'], 2.9, 165, 174, 'Rice', 'QUALITY_ISSUE', false),
    log('log-7', providerId, 15, ['meal-biryani'], 8.3, 190, 215, 'Mixed meal', 'OVERPRODUCTION', true),
    log('log-8', secondProviderId, 2, ['meal-pulao'], 9.6, 320, 350, 'Rice', 'OVERPRODUCTION', true),
    log('log-9', secondProviderId, 6, ['meal-chapati'], 4.1, 305, 320, 'Bread', 'OVERPRODUCTION', true)
  ];
  database.pickups = [
    { id: 'pickup-active', providerId, providerName: 'Green Table Foods', wasteLogId: 'log-1', estimatedWeightKg: 7.4, eligibleRoles: ['FOOD_COLLECTOR'], status: 'AVAILABLE', availableFrom: iso(0, 16), pickupDeadline: iso(0, 20), locality: 'Coimbatore', collectionAddress: '12 Service Road, Coimbatore, Tamil Nadu 641001', collectionInstructions: 'Use the service entrance and ask for the food operations lead.', activity: [], createdAt: iso(-1, 14), updatedAt: iso(-1, 14) },
    { id: 'pickup-reserved', providerId: secondProviderId, providerName: 'Sunrise Public School', wasteLogId: 'log-8', estimatedWeightKg: 9.6, eligibleRoles: ['FOOD_COLLECTOR'], status: 'RESERVED', reservedByAccountId: collectorId, reservedAt: iso(0, 12), reservationExpiresAt: iso(0, 18), availableFrom: iso(0, 13), pickupDeadline: iso(0, 19), locality: 'Coimbatore', collectionAddress: '45 Lake View Road, Coimbatore, Tamil Nadu 641018', collectionInstructions: 'Use the rear kitchen gate beside the staff parking area.', activity: [{ id: 'activity-reserved', fromStatus: 'AVAILABLE', toStatus: 'RESERVED', actorId: collectorId, actorName: 'Karthik Mani', reason: 'Reserved for this afternoon route.', createdAt: iso(0, 12) }], createdAt: iso(-2, 11), updatedAt: iso(0, 12) },
    { id: 'pickup-collected', providerId, providerName: 'Green Table Foods', wasteLogId: 'log-2', estimatedWeightKg: 5.2, eligibleRoles: ['FOOD_COLLECTOR'], status: 'COLLECTED', reservedByAccountId: collectorId, reservedAt: iso(-3, 9), availableFrom: iso(-3, 10), pickupDeadline: iso(-3, 13), locality: 'Coimbatore', collectionAddress: '12 Service Road, Coimbatore, Tamil Nadu 641001', collectionInstructions: 'Use the service entrance and ask for the food operations lead.', activity: [{ id: 'activity-collected-1', fromStatus: 'AVAILABLE', toStatus: 'RESERVED', actorId: collectorId, actorName: 'Karthik Mani', reason: 'Reserved pickup.', createdAt: iso(-3, 9) }, { id: 'activity-collected-2', fromStatus: 'RESERVED', toStatus: 'IN_TRANSIT', actorId: collectorId, actorName: 'Karthik Mani', reason: 'Collector started transit.', createdAt: iso(-3, 10) }, { id: 'activity-collected-3', fromStatus: 'IN_TRANSIT', toStatus: 'COLLECTED', actorId: providerId, actorName: 'Ananya Rao', reason: 'Handoff confirmed at the service entrance.', createdAt: iso(-3, 12) }], createdAt: iso(-4, 14), updatedAt: iso(-3, 12) }
  ];
  database.accessRequests = [{ id: 'request-demo-1', applicantName: 'Rohan Iyer', role: 'FOOD_COLLECTOR', organizationTypeId: 'type-ngo-recovery', organizationName: 'Neighbourhood Harvest NGO', address: '8 Race Course Road, Coimbatore, Tamil Nadu 641018', email: 'rohan@neighbourhoodharvest.org', whatsapp: '+919845678901', preferredContactMethod: 'EMAIL', hasTransportFacilities: true, transportFacilities: 'One refrigerated van and two insulated collection carts.', contact: 'rohan@neighbourhoodharvest.org', organizationTypeName: 'NGO recovery service', requiredDocuments: [], documents: [], status: 'PENDING', createdAt: iso(-1, 9), submittedAt: iso(-1, 9) }];
  const supportId = 'conversation-support-producer';
  const pickupChatId = 'conversation-pickup-active';
  database.chatConversations = [{ id: supportId, type: 'ADMIN_SUPPORT', state: 'OPEN', organizationAccountId: providerId, title: 'Green Table Foods · Admin support', participantAccountIds: [providerId], createdAt: iso(-4, 11), updatedAt: iso(-1, 15), unreadCount: 0 }, { id: pickupChatId, type: 'PICKUP', state: 'OPEN', pickupId: 'pickup-active', organizationAccountId: providerId, title: 'Green Table Foods · Collection', participantAccountIds: [providerId, collectorId], createdAt: iso(-1, 14), updatedAt: iso(-1, 15), unreadCount: 0 }];
  database.chatParticipants = [{ conversationId: supportId, accountId: providerId, joinedAt: iso(-4, 11) }, { conversationId: supportId, accountId: 'acct-admin', joinedAt: iso(-4, 11), lastReadAt: iso(-1, 15) }, { conversationId: pickupChatId, accountId: providerId, joinedAt: iso(-1, 14) }, { conversationId: pickupChatId, accountId: collectorId, joinedAt: iso(-1, 14) }];
  database.chatMessages = [{ id: 'message-support-system', conversationId: supportId, kind: 'SYSTEM', senderOrganizationName: 'Bloom', senderDisplayName: 'Bloom', text: 'This is a private conversation between your organization and Bloom administrators.', attachmentIds: [], idempotencyKey: 'support:presentation-producer', createdAt: iso(-4, 11) }, { id: 'message-support-admin', conversationId: supportId, kind: 'MESSAGE', senderAccountId: 'acct-admin', senderOrganizationName: 'Bloom', senderDisplayName: 'Bloom Administrator', text: 'Your pickup window looks good for today. Let us know if the kitchen schedule changes.', attachmentIds: [], idempotencyKey: 'presentation-support-1', createdAt: iso(-1, 15) }, { id: 'message-pickup-system', conversationId: pickupChatId, kind: 'SYSTEM', senderOrganizationName: 'Bloom', senderDisplayName: 'Bloom', text: 'This private conversation is shared by the producer and collector for this pickup.', attachmentIds: [], idempotencyKey: 'pickup:presentation-active', createdAt: iso(-1, 14) }, { id: 'message-pickup-collector', conversationId: pickupChatId, kind: 'MESSAGE', senderAccountId: collectorId, senderOrganizationName: 'Coimbatore Recovery Collective', senderDisplayName: 'Karthik Mani', text: 'I can reach the service entrance around 4:30 PM. Please keep the containers labelled by meal.', attachmentIds: [], idempotencyKey: 'presentation-pickup-1', createdAt: iso(-1, 15) }];
  database.auditEvents = [{ id: 'audit-request', actorId: 'acct-admin', actorName: 'Bloom Administrator', action: 'REQUEST_REVIEW_STARTED', objectType: 'ACCESS_REQUEST', objectId: 'request-demo-1', objectLabel: 'Neighbourhood Harvest NGO', summary: 'Started review of a new Food Collector access request.', createdAt: iso(-1, 9) }, { id: 'audit-pickup', actorId: 'acct-admin', actorName: 'Bloom Administrator', action: 'PICKUP_REOPENED', objectType: 'PICKUP', objectId: 'pickup-reserved', objectLabel: 'Sunrise Public School', summary: 'Reviewed the reserved pickup record.', createdAt: iso(0, 12) }, { id: 'audit-collected', actorId: providerId, actorName: 'Ananya Rao', action: 'PICKUP_REOPENED', objectType: 'PICKUP', objectId: 'pickup-collected', objectLabel: 'Green Table Foods', summary: 'Recorded a completed collection handoff.', createdAt: iso(-3, 12) }];
  return database;
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
    logs: (raw.logs ?? []).map(({ schoolId, ...log }: any) => ({
      ...log,
      providerId: log.providerId ?? schoolId,
      mealIds: Array.isArray(log.mealIds) ? log.mealIds : [],
      recordedAt: log.recordedAt ?? (log.createdAt || `${log.date}T00:00:00.000Z`)
    })),
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
  constructor(private readonly filePath = resolve(process.cwd(), process.env.PRESENTATION_MODE === 'true' ? 'data/presentation.json' : 'data/dev.json')) {}

  private async ensure() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try { await readFile(this.filePath, 'utf8'); }
    catch { await this.write(process.env.PRESENTATION_MODE === 'true' ? presentationDatabase() : seedDatabase()); }
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

  async findSessionAccount(tokenHash: string) {
    const database = await this.read();
    const session = database.sessions.find((item) => item.tokenHash === tokenHash);
    const account = session && database.accounts.find((item) => item.id === session.accountId);
    return session && account ? { session, account } : null;
  }

  async refreshSession(tokenHash: string, csrfHash: string, lastActivityAt: string) {
    await this.mutate((database) => {
      const session = database.sessions.find((item) => item.tokenHash === tokenHash);
      if (session) Object.assign(session, { csrfHash, lastActivityAt });
    });
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
    const entries = Object.entries(this.tables) as Array<[EntityCollectionKey, string]>;
    const result = await client.query<{ entity_type: EntityCollectionKey; document: unknown }>(
      entries.map(([key, table]) => `SELECT '${key}' AS entity_type, document FROM ${table}`).join(' UNION ALL ')
    );
    for (const key of Object.keys(this.tables) as EntityCollectionKey[]) (state[key] as unknown[]) = [];
    for (const row of result.rows) {
      (state[row.entity_type] as unknown[]).push(row.document);
    }
    return normalizeDatabase(state);
  }

  private async replaceAll(client: PoolClient, state: Database) {
    for (const [key, table] of Object.entries(this.tables) as Array<[keyof typeof this.tables, string]>) {
      await client.query(`DELETE FROM ${table}`);
      const records = (state[key] as unknown as any[]).map((entity) => ({ id: this.entityId(key, entity), document: entity }));
      if (records.length) {
        await client.query(
          `INSERT INTO ${table} (id, document) SELECT item->>'id', item->'document' FROM jsonb_array_elements($1::jsonb) AS item`,
          [JSON.stringify(records)]
        );
      }
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

  async findSessionAccount(tokenHash: string) {
    const result = await this.pool.query<{ session: StoredSession; account: StoredAccount }>(
      `SELECT session.document AS session, account.document AS account
       FROM sessions AS session
       JOIN accounts AS account ON account.id = session.document->>'accountId'
       WHERE session.id = $1
       LIMIT 1`,
      [tokenHash]
    );
    return result.rows[0] ?? null;
  }

  async refreshSession(tokenHash: string, csrfHash: string, lastActivityAt: string) {
    await this.pool.query(
      `UPDATE sessions SET document = document || $2::jsonb WHERE id = $1`,
      [tokenHash, JSON.stringify({ csrfHash, lastActivityAt })]
    );
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
