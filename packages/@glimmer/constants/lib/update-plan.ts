import type { UpdatePlanKind } from '@glimmer/interfaces';

export const PLAN_LEAF = 1 satisfies UpdatePlanKind;
export const PLAN_MULTI = 2 satisfies UpdatePlanKind;
export const PLAN_GUARD = 3 satisfies UpdatePlanKind;
export const PLAN_GUARD_END = 4 satisfies UpdatePlanKind;
export const PLAN_BLOCK = 5 satisfies UpdatePlanKind;
export const PLAN_LIST = 6 satisfies UpdatePlanKind;
export const PLAN_CALL = 7 satisfies UpdatePlanKind;
