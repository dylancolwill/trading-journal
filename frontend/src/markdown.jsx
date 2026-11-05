import React from 'react';

// Shared renderer for model-written markdown (per-trade analysis and period reports).
// Styling lives here so the two pages can't drift apart.
export const mdComponents = {
  h1: ({ children }) => <div style={{ fontSize: 15, fontWeight: 700, margin: '14px 0 6px', color: '#e1e1e6' }}>{children}</div>,
  h2: ({ children }) => <div style={{ fontSize: 14, fontWeight: 700, margin: '12px 0 5px', color: '#e1e1e6' }}>{children}</div>,
  h3: ({ children }) => <div style={{ fontSize: 13, fontWeight: 700, margin: '10px 0 4px', color: '#a1a1aa' }}>{children}</div>,
  p: ({ children }) => <p style={{ margin: '0 0 8px 0', color: '#d4d4d8' }}>{children}</p>,
  ul: ({ children }) => <ul style={{ margin: '0 0 8px 0', paddingLeft: 18 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: '0 0 8px 0', paddingLeft: 18 }}>{children}</ol>,
  li: ({ children }) => <li style={{ marginBottom: 3, color: '#d4d4d8' }}>{children}</li>,
  strong: ({ children }) => <strong style={{ color: '#e1e1e6', fontWeight: 600 }}>{children}</strong>,
  em: ({ children }) => <em style={{ color: '#a78bfa' }}>{children}</em>,
  pre: ({ children }) => <pre style={{ margin: '8px 0', background: '#09090b', border: '1px solid #27272a', borderRadius: 6, padding: 12, overflowX: 'auto', fontSize: 11, lineHeight: 1.5 }}>{children}</pre>,
  code: ({ className, children }) => className
    ? <code style={{ fontFamily: 'monospace', fontSize: 11, color: '#d4d4d8', whiteSpace: 'pre' }}>{children}</code>
    : <code style={{ background: '#09090b', borderRadius: 4, padding: '1px 5px', fontSize: 12, color: '#a78bfa' }}>{children}</code>,
  hr: () => <hr style={{ border: 'none', borderTop: '1px solid #27272a', margin: '10px 0' }} />,
  blockquote: ({ children }) => <blockquote style={{ borderLeft: '3px solid #3f3f46', margin: '0 0 8px 0', paddingLeft: 12, color: '#71717a' }}>{children}</blockquote>,
  table: ({ children }) => <div style={{ overflowX: 'auto', margin: '8px 0' }}><table style={{ borderCollapse: 'collapse', fontSize: 12 }}>{children}</table></div>,
  th: ({ children }) => <th style={{ textAlign: 'left', padding: '4px 10px 4px 0', color: '#71717a', fontWeight: 600, borderBottom: '1px solid #27272a' }}>{children}</th>,
  td: ({ children }) => <td style={{ padding: '4px 10px 4px 0', color: '#d4d4d8', fontVariantNumeric: 'tabular-nums' }}>{children}</td>,
};

// Status palette, shared with the per-trade view: colour never carries meaning alone —
// every chip that uses it also prints its label.
export function gradeColor(g) {
  if (!g) return '#52525b';
  if (g === 'good' || g === 'correct') return '#22c55e';
  if (g === 'ok' || g === 'partial') return '#f59e0b';
  return '#ef4444';
}
