/**
 * Тип для идентификатора таймера
 */
export type TimerToken = object

interface TimerTask {
  token: TimerToken
  executeAt: number
  callback: () => void
}

/**
 * Планировщик таймеров на базе Min-Heap (Двоичная куча).
 * Позволяет эффективно управлять тысячами таймеров, используя единый цикл проверки.
 */
export class TimerScheduler {
  // Min-Heap: элемент с наименьшим executeAt всегда в index 0
  private heap: TimerTask[] = []

  // Set для быстрой проверки отмененных задач (Lazy Cancellation)
  // Это позволяет удалять задачи за O(1) без поиска в куче O(n)
  private activeTokens: WeakSet<TimerToken> = new WeakSet()

  private static instance: TimerScheduler
  private intervalId: any = null
  private pollingInterval = 100 // ms

  private constructor() {}

  public static getInstance(): TimerScheduler {
    if (!TimerScheduler.instance) {
      TimerScheduler.instance = new TimerScheduler()
    }
    return TimerScheduler.instance
  }

  /**
   * Настройка режима опроса
   * @param interval Интервал проверки в мс. Если 0 или null - авто-тик выключается (ручной режим)
   */
  public setPollingInterval(interval: number | null) {
    this.stop()
    if (interval !== null && interval > 0) {
      this.pollingInterval = interval
      this.start()
    }
  }

  /**
   * Проверка активности планировщика
   */
  public isActive(): boolean {
    return this.intervalId !== null
  }

  /**
   * Запуск единого таймера
   */
  public start() {
    if (this.intervalId) return
    this.intervalId = setInterval(() => this.process(), this.pollingInterval)
  }

  /**
   * Остановка единого таймера
   */
  public stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  /**
   * Добавить задачу
   * @param delay задержка в мс
   * @param callback функция для выполнения
   * @returns токен для отмены
   */
  public schedule(delay: number, callback: () => void): TimerToken {
    const token = {}
    const executeAt = Date.now() + delay

    const task: TimerTask = { token, executeAt, callback }

    this.activeTokens.add(token)
    this.insert(task)

    return token
  }

  /**
   * Отменить задачу
   * @param token токен задачи
   */
  public cancel(token: TimerToken) {
    // Просто удаляем из активных токенов.
    // Задача останется в куче, но будет пропущена при обработке (Lazy Delete).
    this.activeTokens.delete(token)
  }

  /**
   * Обработать очередь (вызывается таймером или вручную)
   */
  public process(now: number = Date.now()) {
    while (this.heap.length > 0) {
      // Смотрим на самый ранний таймер
      const task = this.heap[0]

      // Если его время еще не пришло - останавливаемся
      if (task.executeAt > now) {
        break
      }

      // Извлекаем задачу
      this.extractMin()

      // Если задача не была отменена - выполняем
      if (this.activeTokens.has(task.token)) {
        this.activeTokens.delete(task.token)
        try {
          task.callback()
        } catch (e) {
          console.error('Error in scheduled task', e)
        }
      }
    }
  }

  /**
   * Очистить все задачи
   */
  public clear() {
    this.heap = []
    // WeakSet нельзя очистить явно, но это и не нужно,
    // так как без ссылок из heap токены будут собраны GC
    this.activeTokens = new WeakSet()
  }

  // === Min-Heap Implementation ===

  private insert(task: TimerTask) {
    this.heap.push(task)
    this.bubbleUp(this.heap.length - 1)
  }

  private extractMin(): TimerTask | undefined {
    if (this.heap.length === 0) return undefined

    const min = this.heap[0]
    const last = this.heap.pop()!

    if (this.heap.length > 0) {
      this.heap[0] = last
      this.sinkDown(0)
    }

    return min
  }

  private bubbleUp(index: number) {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2)
      if (this.heap[parentIndex].executeAt <= this.heap[index].executeAt) break

      this.swap(index, parentIndex)
      index = parentIndex
    }
  }

  private sinkDown(index: number) {
    const length = this.heap.length
    const element = this.heap[index]

    while (true) {
      const leftChildIdx = 2 * index + 1
      const rightChildIdx = 2 * index + 2
      let swapIdx: number | null = null

      if (leftChildIdx < length) {
        if (this.heap[leftChildIdx].executeAt < element.executeAt) {
          swapIdx = leftChildIdx
        }
      }

      if (rightChildIdx < length) {
        if (
          (swapIdx === null &&
            this.heap[rightChildIdx].executeAt < element.executeAt) ||
          (swapIdx !== null &&
            this.heap[rightChildIdx].executeAt < this.heap[swapIdx].executeAt)
        ) {
          swapIdx = rightChildIdx
        }
      }

      if (swapIdx === null) break

      this.swap(index, swapIdx)
      index = swapIdx
    }
  }

  private swap(a: number, b: number) {
    const temp = this.heap[a]
    this.heap[a] = this.heap[b]
    this.heap[b] = temp
  }
}
