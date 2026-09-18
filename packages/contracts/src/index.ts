export type AccountRole = 'FOOD_WASTE_PRODUCER' | 'FOOD_COLLECTOR' | 'ADMIN';
export type PublicAccountRole = Exclude<AccountRole, 'ADMIN'>;
export type RecoveryRole = Extract<AccountRole, 'FOOD_COLLECTOR'>;
export type AccountStatus = 'ACTIVE' | 'SUSPENDED';
export type AccessRequestStatus = 'DRAFT' | 'PENDING' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED';
export type ContactPreference = 'EMAIL' | 'WHATSAPP';
export type OrganizationNameRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type PickupStatus = 'AVAILABLE' | 'RESERVED' | 'IN_TRANSIT' | 'AWAITING_PROVIDER_CONFIRMATION' | 'COLLECTED' | 'CANCELLED' | 'EXPIRED';
export type WasteReason = 'LOW_ATTENDANCE' | 'MENU_PREFERENCE' | 'OVERPRODUCTION' | 'PREPARATION_WASTE' | 'LOW_DEMAND' | 'FORECAST_VARIANCE' | 'CUSTOMER_PREFERENCE' | 'PORTION_SIZE' | 'QUALITY_ISSUE' | 'PROCESS_ERROR' | 'OTHER';
export type ServicePeriod = 'BREAKFAST' | 'LUNCH' | 'DINNER' | 'ALL_DAY' | 'EVENT' | 'OTHER';
export type WasteStage = 'PREPARATION' | 'STORAGE_SPOILAGE' | 'OVERPRODUCTION' | 'PLATE_RETURN' | 'OTHER';

export interface OrganizationType {
  id: string;
  role: PublicAccountRole;
  name: string;
  active: boolean;
  sortOrder: number;
  documentRequirements: VerificationDocumentRequirement[];
  createdAt: string;
  updatedAt: string;
}

export interface VerificationDocumentRequirement {
  id: string;
  label: string;
  required: boolean;
  sortOrder: number;
}

export interface AccessRequestDocument {
  id: string;
  requestId: string;
  requirementId: string;
  requirementLabel: string;
  fileName: string;
  objectKey: string;
  mediaType: 'application/pdf' | 'image/jpeg' | 'image/png';
  byteSize: number;
  createdAt: string;
}

export interface Account {
  id: string;
  role: AccountRole;
  accessCode: string;
  displayName: string;
  organizationName: string;
  contact: string;
  email?: string;
  emailVerifiedAt?: string;
  phone?: string;
  contactNeedsReview?: boolean;
  organizationTypeId?: string;
  organizationTypeName?: string;
  address?: string;
  weeklyWasteKg?: number;
  hasTransportFacilities?: boolean;
  transportFacilities?: string;
  status: AccountStatus;
  firstLogin: boolean;
  locality?: string;
  collectionAddress?: string;
  collectionInstructions?: string;
  createdAt: string;
}

export interface AccessRequest {
  id: string;
  applicantName: string;
  role: PublicAccountRole;
  organizationTypeId: string;
  organizationTypeName: string;
  organizationName: string;
  address: string;
  contact: string;
  email: string;
  whatsapp: string;
  preferredContactMethod: ContactPreference;
  weeklyWasteKg?: number;
  hasTransportFacilities?: boolean;
  transportFacilities?: string;
  requiredDocuments: VerificationDocumentRequirement[];
  documents: AccessRequestDocument[];
  status: AccessRequestStatus;
  createdAt: string;
  submittedAt?: string;
  reviewStartedAt?: string;
  contactedAt?: string;
  contactChannel?: ContactPreference;
  reviewedAt?: string;
  rejectionReason?: string;
  reviewedBy?: string;
}

export interface OrganizationNameChangeRequest {
  id: string;
  accountId: string;
  currentName: string;
  requestedName: string;
  reason: string;
  status: OrganizationNameRequestStatus;
  createdAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  rejectionReason?: string;
}

export interface Meal {
  id: string;
  providerId: string;
  name: string;
  createdAt: string;
}

export interface RecurrenceRule {
  frequency: 'NONE' | 'WEEKLY' | 'BIWEEKLY';
  endDate?: string;
}

export interface MealAssignment {
  id: string;
  providerId: string;
  date: string;
  mealIds: string[];
  recurrence: RecurrenceRule;
  createdAt: string;
}

export interface DailyWasteLog {
  id: string;
  providerId: string;
  date: string;
  recordedAt?: string;
  servicePeriod?: ServicePeriod;
  wasteStage?: WasteStage;
  foodCategory?: string;
  mealIds?: string[];
  actualAttendance?: number;
  servingsPrepared?: number;
  leftoverKg: number;
  reason: WasteReason;
  suitableForCollection: boolean;
  notes: string;
  pickupId?: string;
  createdAt: string;
}

export interface PickupActivityEvent {
  id: string;
  actorId: string;
  actorName: string;
  fromStatus: PickupStatus;
  toStatus: PickupStatus;
  reason?: string;
  createdAt: string;
}

export interface Pickup {
  id: string;
  providerId: string;
  providerName: string;
  wasteLogId: string;
  estimatedWeightKg: number;
  eligibleRoles: RecoveryRole[];
  status: PickupStatus;
  availableFrom: string;
  pickupDeadline: string;
  locality: string;
  collectionAddress: string;
  collectionInstructions: string;
  reservedByAccountId?: string;
  reservedByName?: string;
  reservedAt?: string;
  reservationExpiresAt?: string;
  activity: PickupActivityEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface RecoveryOverview {
  availablePickups: number;
  activePickup?: Pickup;
  collectedKgLast30Days: number;
  completedPickupsLast30Days: number;
}

export interface Recommendation {
  expectedAttendance: number;
  safetyBuffer: number;
  historicalAdjustment: number;
  recommendedServings: number;
  eligibleLogCount: number;
}

export interface InsightSummary {
  periodDays: number;
  totalLogs: number;
  leftoverPer100Attendees: number | null;
  trend: Array<{ date: string; leftoverKg: number }>;
  topMeals: Array<{ mealId: string; name: string; leftoverKg: number }>;
  topReasons: Array<{ reason: WasteReason; leftoverKg: number }>;
  recommendation: string | null;
  sevenDay: {
    totalKg: number;
    recordCount: number;
    collectionSuitableKg: number;
    changePercent: number | null;
  };
  stageBreakdown: Array<{ stage: WasteStage; wasteKg: number }>;
  serviceBreakdown: Array<{ servicePeriod: ServicePeriod; wasteKg: number }>;
  categoryBreakdown: Array<{ category: string; wasteKg: number }>;
  guidance: string[];
}

export type AdminAuditAction =
  | 'REQUEST_REVIEW_STARTED' | 'REQUEST_CONTACTED' | 'REQUEST_APPROVED' | 'REQUEST_REJECTED'
  | 'ACCOUNT_CREATED' | 'ACCOUNT_TYPE_CHANGED' | 'ACCOUNT_SUSPENDED' | 'ACCOUNT_REACTIVATED' | 'ACCOUNT_PASSPHRASE_RESET'
  | 'ORGANIZATION_TYPE_CREATED' | 'ORGANIZATION_TYPE_UPDATED' | 'ORGANIZATION_TYPE_ARCHIVED' | 'ORGANIZATION_TYPE_DELETED'
  | 'PICKUP_CANCELLED' | 'PICKUP_EXPIRED' | 'PICKUP_REOPENED'
  | 'ACCOUNT_HOLDER_UPDATED' | 'ACCOUNT_PASSPHRASE_CHANGED'
  | 'ORGANIZATION_NAME_REQUESTED' | 'ORGANIZATION_NAME_APPROVED' | 'ORGANIZATION_NAME_REJECTED'
  | 'CHAT_ADMIN_JOINED' | 'CHAT_MESSAGE_HIDDEN';

export interface AdminAuditEvent {
  id: string;
  actorId: string;
  actorName: string;
  action: AdminAuditAction;
  objectType: 'ACCESS_REQUEST' | 'ACCOUNT' | 'ORGANIZATION_TYPE' | 'ORGANIZATION_NAME_REQUEST' | 'PICKUP' | 'CHAT_CONVERSATION' | 'CHAT_MESSAGE';
  objectId: string;
  objectLabel: string;
  summary: string;
  reason?: string;
  createdAt: string;
}

export interface AdminOverview {
  pendingRequests: number;
  pendingNameChanges: number;
  activeOrganizations: number;
  pickupExceptions: number;
  collectedKgLast30Days: number;
  recentActivity: AdminAuditEvent[];
}

export type ChatConversationType = 'PICKUP' | 'ADMIN_SUPPORT';
export type ChatConversationState = 'OPEN' | 'READ_ONLY';

export interface ChatConversation {
  id: string;
  type: ChatConversationType;
  state: ChatConversationState;
  organizationAccountId?: string;
  pickupId?: string;
  title: string;
  participantAccountIds: string[];
  adminJoinedAt?: string;
  terminalAt?: string;
  createdAt: string;
  updatedAt: string;
  lastMessage?: ChatMessage;
  unreadCount: number;
}

export interface ChatParticipant {
  conversationId: string;
  accountId: string;
  joinedAt: string;
  lastReadAt?: string;
  lastReadMessageId?: string;
}

export interface ChatAttachment {
  id: string;
  conversationId: string;
  messageId?: string;
  objectKey: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  width: number;
  height: number;
  byteSize: number;
  createdAt: string;
  expiresAt: string;
  accessUrl?: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderAccountId?: string;
  senderOrganizationName: string;
  senderDisplayName: string;
  kind: 'MESSAGE' | 'SYSTEM' | 'MODERATION';
  text: string;
  attachmentIds: string[];
  idempotencyKey: string;
  hiddenAt?: string;
  hiddenReason?: string;
  createdAt: string;
}

export interface ChatEvent {
  type: 'message.created' | 'conversation.updated' | 'receipt.updated' | 'pickup.updated' | 'session.revoked';
  conversationId?: string;
  payload?: unknown;
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
