import { useEffect, useState } from 'react';

export const MOBILE_QUERY = '(max-width: 760px)';

export function useMobile(): boolean {
  const [m, setM] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mq = matchMedia(MOBILE_QUERY);
    const h = () => setM(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return m;
}
