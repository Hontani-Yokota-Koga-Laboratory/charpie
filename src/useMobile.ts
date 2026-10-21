import { useEffect, useState } from 'react';

/** phones held either way (keep in step with the @media blocks in styles.css / FileGallery.css) */
export const MOBILE_QUERY = '(max-width: 760px), (pointer: coarse) and (max-height: 500px)';

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
