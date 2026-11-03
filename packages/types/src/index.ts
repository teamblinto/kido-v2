export type ServiceStatus = 'ok' | 'error' | 'shutting_down';

export interface HealthIndicatorResult {
  status: 'up' | 'down';
  [key: string]: unknown;
}

export interface ApiHealthResponse {
  status: ServiceStatus;
  info?: Record<string, HealthIndicatorResult | undefined>;
  error?: Record<string, HealthIndicatorResult | undefined>;
  details: Record<string, HealthIndicatorResult>;
}

export interface ApiRootResponse {
  name: string;
  status: 'running';
  timestamp: string;
  version: string;
}
