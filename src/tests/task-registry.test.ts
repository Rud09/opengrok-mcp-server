import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createTask,
  getTask,
  completeTask,
  failTask,
  listTasks,
  clearAllTasks,
} from '../server/task-registry.js';

describe('task-registry lifecycle', () => {
  afterEach(() => clearAllTasks());

  it('createTask returns a non-empty string ID', () => {
    const id = createTask();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('createTask IDs start with "task_"', () => {
    const id = createTask();
    expect(id.startsWith('task_')).toBe(true);
  });

  it('getTask returns running status immediately after create', () => {
    const id = createTask();
    const task = getTask(id);
    expect(task).not.toBeNull();
    expect(task?.status).toBe('running');
  });

  it('getTask stores createdAt timestamp', () => {
    const before = Date.now();
    const id = createTask();
    const after = Date.now();
    const task = getTask(id);
    expect(task?.createdAt).toBeGreaterThanOrEqual(before);
    expect(task?.createdAt).toBeLessThanOrEqual(after);
  });

  it('create → complete lifecycle', () => {
    const id = createTask();
    completeTask(id, 'result string');
    const task = getTask(id);
    expect(task?.status).toBe('completed');
    expect(task?.result).toBe('result string');
  });

  it('completed task has completedAt set', () => {
    const id = createTask();
    const before = Date.now();
    completeTask(id, 'done');
    const after = Date.now();
    const task = getTask(id);
    expect(task?.completedAt).toBeGreaterThanOrEqual(before);
    expect(task?.completedAt).toBeLessThanOrEqual(after);
  });

  it('create → fail lifecycle sets status to "error"', () => {
    const id = createTask();
    failTask(id, 'Timeout exceeded');
    const task = getTask(id);
    expect(task?.status).toBe('error');
    expect(task?.error).toBe('Timeout exceeded');
  });

  it('failed task has completedAt set', () => {
    const id = createTask();
    const before = Date.now();
    failTask(id, 'boom');
    const after = Date.now();
    const task = getTask(id);
    expect(task?.completedAt).toBeGreaterThanOrEqual(before);
    expect(task?.completedAt).toBeLessThanOrEqual(after);
  });

  it('listTasks returns all created tasks', () => {
    const id1 = createTask();
    const id2 = createTask();
    const all = listTasks();
    const ids = all.map(t => t.taskId);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  it('listTasks includes status for each task', () => {
    const id = createTask();
    completeTask(id, 'done');
    const all = listTasks();
    const found = all.find(t => t.taskId === id);
    expect(found?.status).toBe('completed');
  });

  it('listTasks returns empty array after clearAllTasks', () => {
    createTask();
    createTask();
    clearAllTasks();
    expect(listTasks().length).toBe(0);
  });

  it('clearAllTasks is idempotent', () => {
    createTask();
    clearAllTasks();
    clearAllTasks();
    expect(listTasks().length).toBe(0);
  });

  it('getTask returns null for unknown ID', () => {
    expect(getTask('nonexistent-task-id')).toBeNull();
  });

  it('completeTask on unknown ID does not throw', () => {
    expect(() => completeTask('nonexistent', 'result')).not.toThrow();
  });

  it('failTask on unknown ID does not throw', () => {
    expect(() => failTask('nonexistent', 'error')).not.toThrow();
  });

  it('no ID collision under concurrent creation (50 tasks)', () => {
    const ids = Array.from({ length: 50 }, () => createTask());
    const unique = new Set(ids);
    expect(unique.size).toBe(50);
  });

  it('multiple tasks can be in different states simultaneously', () => {
    const id1 = createTask();
    const id2 = createTask();
    const id3 = createTask();
    completeTask(id1, 'ok');
    failTask(id2, 'err');
    // id3 remains running
    expect(getTask(id1)?.status).toBe('completed');
    expect(getTask(id2)?.status).toBe('error');
    expect(getTask(id3)?.status).toBe('running');
  });

  it('TTL expires running tasks after 30 min', () => {
    vi.useFakeTimers();
    const id = createTask();
    // Task is running right now
    expect(getTask(id)?.status).toBe('running');
    // Advance time by 31 minutes
    vi.advanceTimersByTime(31 * 60 * 1000);
    // After TTL, getTask should return null (expired)
    expect(getTask(id)).toBeNull();
    vi.useRealTimers();
  });

  it('completed tasks are not expired after 30 min (uses 1h TTL)', () => {
    vi.useFakeTimers();
    const id = createTask();
    completeTask(id, 'done');
    // Advance only 31 minutes — completed tasks use 1h TTL
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(getTask(id)).not.toBeNull();
    vi.useRealTimers();
  });

  it('completed tasks expire after 1 hour', () => {
    vi.useFakeTimers();
    const id = createTask();
    completeTask(id, 'done');
    vi.advanceTimersByTime(61 * 60 * 1000);
    expect(getTask(id)).toBeNull();
    vi.useRealTimers();
  });

  it('listTasks result includes taskId and createdAt fields', () => {
    const id = createTask();
    const tasks = listTasks();
    const task = tasks.find(t => t.taskId === id);
    expect(task).toBeDefined();
    expect(typeof task?.taskId).toBe('string');
    expect(typeof task?.createdAt).toBe('number');
  });
});
