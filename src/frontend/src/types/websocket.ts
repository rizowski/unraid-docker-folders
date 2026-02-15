/**
 * WebSocket event type definitions
 */

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface WebSocketEvent {
  type: 'event';
  entity: 'container' | 'folder';
  action: string;
  data: unknown;
  timestamp: number;
}
