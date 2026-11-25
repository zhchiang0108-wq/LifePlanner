export interface User { id: string; email: string }
export interface Credentials { email: string; password: string }
export interface AuthResponse { user: User }
export interface EventInput { reminderAt?: string | null; title: string; start: string; end: string; allDay?: boolean; hidden?: boolean; confirmOverlap?: boolean; confirmationToken?: string }
export interface PlannerEvent extends EventInput { id: string; hidden: boolean }
export interface TaskInput { reminderAt?: string | null; title: string; start: string | null; end: string | null; completed?: boolean; confirmOverlap?: boolean; confirmationToken?: string }
export interface TaskPatch extends Partial<TaskInput> {}
export interface PlannerTask extends TaskInput { id: string; completed: boolean }
export interface ApiError { error: string; conflicts?: (PlannerEvent | PlannerTask)[]; confirmationToken?: string }
