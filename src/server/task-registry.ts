/**
 * Simple in-memory task registry for long-running operations like opengrok_execute.
 * Stores task status and results; clients can poll for completion.
 */

export type TaskStatus = "running" | "completed" | "error";

export interface TaskResult {
  status: TaskStatus;
  result?: string;
  error?: string;
  createdAt: number; // timestamp in ms
  completedAt?: number; // timestamp in ms
}

const tasks = new Map<string, TaskResult>();

// Clean up completed tasks older than 1 hour
const TASK_TTL_MS = 3600000;

export function createTask(): string {
  // Use a simple counter-based ID for deterministic testing
  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  tasks.set(taskId, {
    status: "running",
    createdAt: Date.now(),
  });
  return taskId;
}

export function getTask(taskId: string): TaskResult | null {
  const task = tasks.get(taskId);
  if (!task) return null;

  // Clean up old completed tasks
  if (task.status !== "running" && task.completedAt && Date.now() - task.completedAt > TASK_TTL_MS) {
    tasks.delete(taskId);
    return null;
  }

  return task;
}

export function completeTask(taskId: string, result: string): void {
  const task = tasks.get(taskId);
  if (task) {
    task.status = "completed";
    task.result = result;
    task.completedAt = Date.now();
  }
}

export function failTask(taskId: string, error: string): void {
  const task = tasks.get(taskId);
  if (task) {
    task.status = "error";
    task.error = error;
    task.completedAt = Date.now();
  }
}

export function listTasks(): { taskId: string; status: TaskStatus; createdAt: number; completedAt?: number }[] {
  const result = [];
  for (const [taskId, task] of tasks.entries()) {
    // Clean up old tasks
    if (task.status !== "running" && task.completedAt && Date.now() - task.completedAt > TASK_TTL_MS) {
      tasks.delete(taskId);
      continue;
    }
    result.push({
      taskId,
      status: task.status,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
    });
  }
  return result;
}

export function clearAllTasks(): void {
  tasks.clear();
}
