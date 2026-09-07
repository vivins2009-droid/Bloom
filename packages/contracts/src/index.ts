export type AccountRole = 'SCHOOL' | 'FARMER_COLLECTOR' | 'COMPOSTER' | 'ADMIN';
export type AccessRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type PickupStatus = 'AVAILABLE' | 'RESERVED' | 'IN_TRANSIT' | 'AWAITING_SCHOOL_CONFIRMATION' | 'COLLECTED' | 'CANCELLED' | 'EXPIRED';
export type WasteReason = 'LOW_ATTENDANCE' | 'MENU_PREFERENCE' | 'OVERPRODUCTION' | 'PREPARATION_WASTE' | 'OTHER';

export interface Account {
  id: string;
  role: AccountRole;
  accessCode: string;
  displayName: string;
  organizationName: string;
  firstLogin: boolean;
  createdAt: string;
}

export interface AccessRequest {
  id: string;
  applicantName: string;
  role: Exclude<AccountRole, 'ADMIN'>;
  organizationName: string;
  contact: string;
  note: string;
  status: AccessRequestStatus;
  createdAt: string;
  reviewedAt?: string;
  rejectionReason?: string;
}

export interface Meal {
  id: string;
  schoolId: string;
  name: string;
  createdAt: string;
}

export interface RecurrenceRule {
  frequency: 'NONE' | 'WEEKLY' | 'BIWEEKLY';
  endDate?: string;
}

export interface MealAssignment {
  id: string;
  schoolId: string;
  date: string;
  mealIds: string[];
  recurrence: RecurrenceRule;
  createdAt: string;
}

export interface DailyWasteLog {
  id: string;
  schoolId: string;
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
  schoolId: string;
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

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
