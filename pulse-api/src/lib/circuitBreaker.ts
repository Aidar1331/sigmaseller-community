/**
 * Circuit Breaker pattern for external API calls (LLM, etc.).
 *
 * States:
 *  - CLOSED  – normal operation, failures are counted
 *  - OPEN    – calls are rejected immediately
 *  - HALF_OPEN – a limited number of probe calls are allowed
 */

// ── Types ──────────────────────────────────────────────────────────

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  /** How many consecutive failures before opening the circuit. Default 5. */
  failureThreshold?: number;
  /** How long (ms) the circuit stays OPEN before switching to HALF_OPEN. Default 60 000. */
  resetTimeoutMs?: number;
  /** Max probe attempts allowed in HALF_OPEN state. Default 1. */
  halfOpenMaxAttempts?: number;
}

export interface CircuitBreakerStateInfo {
  state: CircuitState;
  failureCount: number;
  successesSinceLastOpen: number;
  lastFailureTime: number | null;
}

// ── Error ──────────────────────────────────────────────────────────

export class CircuitBreakerOpenError extends Error {
  constructor(message = 'Circuit breaker is OPEN – call rejected') {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}

// ── Implementation ─────────────────────────────────────────────────

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private successesSinceLastOpen = 0;
  private lastFailureTime: number | null = null;
  private halfOpenAttempts = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxAttempts: number;

  constructor(config: CircuitBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? 5;
    this.resetTimeoutMs = config.resetTimeoutMs ?? 60_000;
    this.halfOpenMaxAttempts = config.halfOpenMaxAttempts ?? 1;
  }

  // ── Public API ───────────────────────────────────────────────────

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if OPEN should transition to HALF_OPEN
    if (this.state === 'OPEN') {
      if (this.shouldTransitionToHalfOpen()) {
        this.toHalfOpen();
      } else {
        throw new CircuitBreakerOpenError();
      }
    }

    if (this.state === 'HALF_OPEN' && this.halfOpenAttempts >= this.halfOpenMaxAttempts) {
      throw new CircuitBreakerOpenError('Circuit breaker is HALF_OPEN – max probe attempts reached');
    }

    if (this.state === 'HALF_OPEN') {
      this.halfOpenAttempts++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  getState(): CircuitBreakerStateInfo {
    // Auto-check OPEN -> HALF_OPEN on read as well
    if (this.state === 'OPEN' && this.shouldTransitionToHalfOpen()) {
      this.toHalfOpen();
    }

    return {
      state: this.state,
      failureCount: this.failureCount,
      successesSinceLastOpen: this.successesSinceLastOpen,
      lastFailureTime: this.lastFailureTime,
    };
  }

  reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successesSinceLastOpen = 0;
    this.lastFailureTime = null;
    this.halfOpenAttempts = 0;
  }

  // ── Internal helpers ─────────────────────────────────────────────

  private shouldTransitionToHalfOpen(): boolean {
    if (this.lastFailureTime === null) return false;
    return Date.now() - this.lastFailureTime >= this.resetTimeoutMs;
  }

  private toHalfOpen(): void {
    this.state = 'HALF_OPEN';
    this.halfOpenAttempts = 0;
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      // Recovery confirmed – close the circuit
      this.state = 'CLOSED';
      this.failureCount = 0;
      this.halfOpenAttempts = 0;
    }
    this.successesSinceLastOpen++;
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      // Probe failed – reopen immediately
      this.state = 'OPEN';
      this.halfOpenAttempts = 0;
      this.successesSinceLastOpen = 0;
    } else if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      this.successesSinceLastOpen = 0;
    }
  }
}

// ── Pre-configured instance for LLM calls ─────────────────────────

export const llmCircuitBreaker = new CircuitBreaker({
  failureThreshold: 10,
  resetTimeoutMs: 15_000,
  halfOpenMaxAttempts: 3,
});
