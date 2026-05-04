import { createMachine, type IMonitor, type TransitionContext, type MonitorMetricsSnapshot } from '@vedmalex/statemachine'

interface ObservedContext { state: string }

class CustomMonitor implements IMonitor {
  private transitions = 0
  private errors = 0

  recordTransition(_duration: number, success: boolean, _context?: TransitionContext): void {
    this.transitions++
    if (!success) this.errors++
  }

  recordError(_error: Error): void {
    this.errors++
  }

  getMetrics(): MonitorMetricsSnapshot {
    return {
      totalTransitions: this.transitions,
      successCount: this.transitions - this.errors,
      errorCount: this.errors,
      averageDuration: 0,
    }
  }
}

const monitor = new CustomMonitor()
const context: ObservedContext = { state: 's' }

// createMachine signature: createMachine(config, owner?: T | Adapter<T>, options?: StateMachineOptions)
// Pass context as owner and { monitor } as options (3rd arg).
const m = createMachine<ObservedContext>({
  name: 'observed',
  initialState: 's',
  stateAttribute: 'state',
  states: { s: {} },
  events: {},
}, context, { monitor })

console.log('Custom monitor example: currentState =', m.currentState)
console.log('Custom monitor example: metrics =', monitor.getMetrics())
