import React from 'react';

// Chevron toggle used to collapse/expand a chart box.
export function CollapseToggle({ collapsed, onToggle, title }) {
  return (
    <button
      onClick={onToggle}
      title={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
      style={{
        background: 'transparent', border: '1px solid #27272a', borderRadius: 6, color: '#a1a1aa',
        width: 22, height: 22, cursor: 'pointer', fontSize: 10, lineHeight: 1, padding: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
      {collapsed ? '▶' : '▼'}
    </button>
  );
}
