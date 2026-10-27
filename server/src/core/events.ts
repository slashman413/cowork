import { EventEmitter } from 'events';
import type { CoworkEventPayloads, CoworkEventType, ActiveAgent, Task } from '../types.js';

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

  public emitAgentRegistered(agent: ActiveAgent): void {
    this.emitEvent('agentRegistered', { agent });
  }

  public emitTaskCreated(task: Task): void {
    this.emitEvent('taskCreated', { task });
  }

  public emitTaskClaimed(task: Task, agentId: string): void {
    this.emitEvent('taskClaimed', { task, agentId });
  }

  public emitTaskCompleted(task: Task): void {
    this.emitEvent('taskCompleted', { task });
  }

  public emitHeartbeat(agentId: string, status: string, currentTask?: string): void {
    this.emitEvent('heartbeat', { agentId, status, currentTask });
  }

  /** A task was deleted — the dispatcher kills its running brain process tree. */
  public emitTaskDeleted(taskId: string, status?: string): void {
    this.emitEvent('taskDeleted', { taskId, status });
  }

  public emitBrainExecuted(brainId: string, exec: string, taskId: string): void {
    this.emitEvent('brainExecuted', { brainId, exec, taskId });
  }
}
