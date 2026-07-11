/**
 * WebSocket event type definitions
 */

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface WebSocketEvent {
  type: 'event';
  entity: 'container' | 'folder' | 'compose' | 'schedules' | 'updates';
  action: string;
  data: unknown;
  timestamp: number;
}
