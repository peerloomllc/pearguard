import { useEffect, useState } from 'react';

export function localDateStr(ts) {
  const d = new Date(ts || Date.now());
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Returns the current local date string (YYYY-MM-DD) and updates when the
// local calendar day rolls over. Callers depend on the returned value so
// "today"-scoped displays reset at midnight without waiting for a new sync.
export function useLocalDate() {
  const [date, setDate] = useState(() => localDateStr());

  useEffect(() => {
    let timeoutId = null;
    let cancelled = false;

    function schedule() {
      if (cancelled) return;
      const now = new Date();
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1, 0);
      const delay = Math.max(1000, nextMidnight.getTime() - now.getTime());
      timeoutId = setTimeout(() => {
        if (cancelled) return;
        setDate(localDateStr());
        schedule();
      }, delay);
    }

    schedule();
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, []);

  return date;
}
