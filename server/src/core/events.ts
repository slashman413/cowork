import { EventEmitter } from 'events';
import type { CoworkEventPayloads, CoworkEventType, ActiveWorker, Task } from '../types.js';

export class EventBus extends EventEmitter {
  public emitEvent<T extends CoworkEventType>(type: T, payload: CoworkEventPayloads[T]): void {
    const event = {
      type,
      payload,
      timestamp: new Date().toISOString()
    };
    this.emit(type, event);
    this.emit('*', event); // wildcard for all events
  }

  public emitWorkerRegistered(worker: ActiveWorker): void {
    this.emitEvent('workerRegistered', { worker });
  }

  public emitTaskCreated(task: Task): void {
    this.emitEvent('taskCreated', { task });
  }

  public emitTaskClaimed(task: Task, workerId: string): void {
    this.emitEvent('taskClaimed', { task, workerId });
  }

  public emitTaskCompleted(task: Task): void {
    this.emitEvent('taskCompleted', { task });
  }

  public emitHeartbeat(workerId: string, status: string, currentTask?: string): void {
    this.emitEvent('heartbeat', { workerId, status, currentTask });
  }

  /** A task was deleted — the dispatcher kills its running agent process tree. */
  public emitTaskDeleted(taskId: string, status?: string): void {
    this.emitEvent('taskDeleted', { taskId, status });
  }

  /** A person paused a task: the dispatcher stops its running agent (if any). */
  public emitTaskPaused(task: Task, from: string): void {
    this.emitEvent('taskPaused', { task, from });
  }

  public emitTaskResumed(task: Task): void {
    this.emitEvent('taskResumed', { task });
  }

  public emitAgentExecuted(agentId: string, exec: string, taskId: string): void {
    this.emitEvent('agentExecuted', { agentId, exec, taskId });
  }
}
