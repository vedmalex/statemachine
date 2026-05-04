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

// createMachine signature: createMachine(config, owner?: T | Adapter<T>, options?: StateMachineOptions)
// Pass undefined as owner so { monitor } reaches StateMachineOptions (3rd arg).
// Passing { monitor } as 2nd arg would wrap it as a MemoryAdapter owner — wrong wiring.
createMachine<ObservedContext>({
  name: 'observed',
  initialState: 's',
  stateAttribute: 'state',
  states: { s: {} },
  events: {},
}, undefined, { monitor })

console.log('Custom monitor example: injected successfully')
console.log('Custom monitor example: metrics =', monitor.getMetrics())
