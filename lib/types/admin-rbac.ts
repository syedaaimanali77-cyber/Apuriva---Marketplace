/** Spec 009 §3 request/response types. */
import type { ADMIN_ACTION_STATUSES, ADMIN_ROLES, RISK_TIERS } from '@/lib/db/schema';

export type AdminRole = (typeof ADMIN_ROLES)[number];
export type RiskTier = (typeof RISK_TIERS)[number];
export type AdminActionStatus = (typeof ADMIN_ACTION_STATUSES)[number];
export type ApprovalDecision = 'approved' | 'rejected';

export interface AdminRoleDto {
  id: string;
  name: AdminRole;
}

export interface PendingApprovalDto {
  id: string;
  resource: string;
  actionType: string;
  riskTier: RiskTier;
  initiatedBy: string;
  initiatedAt: string;
  targetSummary: string;
  reason: string;
}

export interface PendingReviewDto {
  id: string;
  resource: string;
  actionType: string;
  initiatedBy: string;
  executedAt: string;
  targetSummary: string;
  reason: string;
  isEmergencyBypass: true;
}

export interface ApprovalDto {
  id: string;
  adminActionId: string;
  decision: ApprovalDecision;
  status: AdminActionStatus;
  decidedAt: string;
}

export interface AssignRoleRequest {
  role: AdminRole;
}

export interface AssignRoleResponse {
  userId: string;
  role: AdminRole;
}

export interface PostActionReviewRequest {
  notes: string;
}

export interface PostActionReviewResponse {
  id: string;
  status: AdminActionStatus;
  postActionReviewedAt: string;
}
