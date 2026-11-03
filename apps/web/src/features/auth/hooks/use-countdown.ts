import { useCallback, useEffect, useState } from 'react';

interface Countdown {
  /** Remaining time as `m:ss`. */
  formatted: string;
  isRunning: boolean;
  restart: () => void;
  secondsLeft: number;
}

/** Counts down from `seconds` to zero, once per second. */
export function useCountdown(seconds: number): Countdown {
  const [secondsLeft, setSecondsLeft] = useState(seconds);
  const isRunning = secondsLeft > 0;

  useEffect(() => {
    if (!isRunning) {
      return;
    }

    const timer = window.setInterval(() => {
      setSecondsLeft((current) => Math.max(0, current - 1));
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [isRunning]);

  const restart = useCallback(() => {
    setSecondsLeft(seconds);
  }, [seconds]);

  const minutes = Math.floor(secondsLeft / 60);
  const remainder = secondsLeft % 60;

  return {
    formatted: `${String(minutes)}:${String(remainder).padStart(2, '0')}`,
    isRunning,
    restart,
    secondsLeft,
  };
}
