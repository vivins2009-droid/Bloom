export type AccountRole = 'FOOD_PROVIDER' | 'FARMER_COLLECTOR' | 'COMPOSTER' | 'ADMIN';
export type PublicAccountRole = Exclude<AccountRole, 'ADMIN'>;
export type AccountStatus = 'ACTIVE' | 'SUSPENDED';
export type AccessRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type OrganizationNameRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type PickupStatus = 'AVAILABLE' | 'RESERVED' | 'IN_TRANSIT' | 'AWAITING_PROVIDER_CONFIRMATION' | 'COLLECTED' | 'CANCELLED' | 'EXPIRED';
export type WasteReason = 'LOW_ATTENDANCE' | 'MENU_PREFERENCE' | 'OVERPRODUCTION' | 'PREPARATION_WASTE' | 'OTHER';

export interface OrganizationType {
  id: string;
  role: PublicAccountRole;
  name: string;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Account {
  id: string;
  role: AccountRole;
  accessCode: string;
  displayName: string;
  organizationName: string;
  contact: string;
  organizationTypeId?: string;
  status: AccountStatus;
  firstLogin: boolean;
  createdAt: string;
}

export interface AccessRequest {
  id: string;
  applicantName: string;
  role: PublicAccountRole;
  organizationTypeId: string;
  organizationTypeName: string;
  organizationName: string;
  contact: string;
  note: string;
  status: AccessRequestStatus;
  createdAt: string;
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
  mealIds: string[];
  actualAttendance: number;
  servingsPrepared: number;
  leftoverKg: number;
  reason: WasteReason;
  suitableForCollection: boolean;
  notes: string;
  pickupId?: string;
  createdAt: string;
}

export interface Pickup {
  id: string;
  providerId: string;
  wasteLogId: string;
  estimatedWeightKg: number;
  destination: 'LIVESTOCK_OR_COMPOST';
  status: PickupStatus;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
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
}

export type AdminAuditAction =
  | 'REQUEST_APPROVED' | 'REQUEST_REJECTED'
  | 'ACCOUNT_CREATED' | 'ACCOUNT_TYPE_CHANGED' | 'ACCOUNT_SUSPENDED' | 'ACCOUNT_REACTIVATED' | 'ACCOUNT_PASSPHRASE_RESET'
  | 'ORGANIZATION_TYPE_CREATED' | 'ORGANIZATION_TYPE_UPDATED' | 'ORGANIZATION_TYPE_ARCHIVED' | 'ORGANIZATION_TYPE_DELETED'
  | 'PICKUP_CANCELLED' | 'PICKUP_EXPIRED' | 'PICKUP_REOPENED'
  | 'ACCOUNT_HOLDER_UPDATED' | 'ACCOUNT_PASSPHRASE_CHANGED'
  | 'ORGANIZATION_NAME_REQUESTED' | 'ORGANIZATION_NAME_APPROVED' | 'ORGANIZATION_NAME_REJECTED';

export interface AdminAuditEvent {
  id: string;
  actorId: string;
  actorName: string;
  action: AdminAuditAction;
  objectType: 'ACCESS_REQUEST' | 'ACCOUNT' | 'ORGANIZATION_TYPE' | 'ORGANIZATION_NAME_REQUEST' | 'PICKUP';
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

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
