import React, { useEffect, useState } from 'react';
import { getLevelsForTrade } from './api';

// Fetch the imported chart levels that match a trade's day + instrument.
export function useTradeLevels(tradeId) {
  const [objects, setObjects] = useState([]);
  useEffect(() => {
    let alive = true;
    getLevelsForTrade(tradeId).then(d => { if (alive) setObjects((d && d.objects) || []); }).catch(() => {});
    return () => { alive = false; };
  }, [tradeId]);
  return objects;
}
