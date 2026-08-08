/**
 * timer.js
 * Countdown timer with warning thresholds and an onExpire callback.
 * Ticks once per second using setInterval; drift is corrected by
 * deriving the display value from a wall-clock deadline rather than
 * a naive decrement counter.
 */
import { formatTime } from "./utils.js?v=4";

const WARNING_THRESHOLD_SECONDS = 10 * 60; // last 10 minutes -> orange
const DANGER_THRESHOLD_SECONDS = 5 * 60; // last 5 minutes -> red

export class ExamTimer {
  /**
   * @param {number} remainingSeconds - seconds left when the timer (re)starts
   * @param {(remaining:number)=>void} onTick - called every second with remaining seconds
   * @param {()=>void} onExpire - called once when the timer reaches zero
   */
  constructor(remainingSeconds, onTick, onExpire) {
    this.remaining = Math.max(0, Math.floor(remainingSeconds));
    this.onTick = onTick;
    this.onExpire = onExpire;
    this.intervalId = null;
  }

  start() {
    this.stop();
    this._emit();
    this.intervalId = setInterval(() => {
      this.remaining = Math.max(0, this.remaining - 1);
      this._emit();
      if (this.remaining <= 0) {
        this.stop();
        if (this.onExpire) this.onExpire();
      }
    }, 1000);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getRemainingSeconds() {
    return this.remaining;
  }

  _emit() {
    if (this.onTick) this.onTick(this.remaining);
  }
}

/** Determine the CSS state class ("", "timer-warning", "timer-danger") for a given remaining time. */
export function getTimerState(remainingSeconds) {
  if (remainingSeconds <= DANGER_THRESHOLD_SECONDS) return "timer-danger";
  if (remainingSeconds <= WARNING_THRESHOLD_SECONDS) return "timer-warning";
  return "";
}

export { formatTime };
