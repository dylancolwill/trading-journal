import React, { useEffect, useState } from 'react';
import { getTags, createTag, deleteTag } from '../api';

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#3b82f6', '#8b5cf6', '#ef4444', '#f97316', '#22c55e', '#ec4899', '#06b6d4', '#84cc16', '#a78bfa', '#566100', '#d737a2', '#ff3838', '#4a8780', '#0000ff', '#234652', '#bc7509', '#cab444'];

const s = {
  page: { padding: 24, maxWidth: 700, margin: '0 auto' },
  card: { background: '#18181b', borderRadius: 10, border: '1px solid #27272a', padding: 20, marginBottom: 16 },
  groupHeader: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 7 },
  dot: (color) => ({ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }),
  tagRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid #27272a' },
  tag: { display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 6, padding: '3px 10px', fontWeight: 600, fontSize: 13 },
  btnDanger: { background: 'transparent', border: 'none', color: '#52525b', cursor: 'pointer', fontSize: 12, padding: '4px 8px', lineHeight: 1 },
  addRow: { display: 'flex', gap: 8, marginTop: 10 },
  input: { background: '#09090b', border: '1px solid #27272a', borderRadius: 6, padding: '6px 10px', color: '#e1e1e6', fontSize: 13, flex: 1 },
  btnAdd: { background: 'transparent', border: '1px solid #3f3f46', borderRadius: 6, color: '#a1a1aa', padding: '6px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' },
  btn: { background: '#a78bfa', color: '#1e1b4b', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 },
  swatch: { width: 20, height: 20, borderRadius: 4, cursor: 'pointer', border: '2px solid transparent', flexShrink: 0 },
};

export default function Tags() {
  const [tags, setTags] = useState([]);
  const [pendingGroups, setPendingGroups] = useState([]); // groups not yet in DB
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupColor, setNewGroupColor] = useState(COLORS[0]);
  const [newTagInputs, setNewTagInputs] = useState({}); // { groupName: inputValue }

  const load = () => getTags().then(setTags).catch(console.error);
  useEffect(() => { load(); }, []);

  // Derive groups from tags
  const groupMap = {};
  for (const tag of tags) {
    const g = tag.group_name || '';
    if (!groupMap[g]) groupMap[g] = { name: g, color: tag.group_color || tag.color, tags: [] };
    groupMap[g].tags.push(tag);
  }
  const dbGroups = Object.values(groupMap).filter(g => g.name).sort((a, b) => a.name.localeCompare(b.name));
  const dbGroupNames = new Set(dbGroups.map(g => g.name));
  const allGroups = [
    ...dbGroups,
    ...pendingGroups.filter(pg => !dbGroupNames.has(pg.name)),
  ];

  const handleAddGroup = (e) => {
    e.preventDefault();
    const name = newGroupName.trim().toLowerCase();
    if (!name) return;
    if (dbGroupNames.has(name) || pendingGroups.some(g => g.name === name)) return;
    setPendingGroups(prev => [...prev, { name, color: newGroupColor }]);
    setNewGroupName('');
  };

  const handleAddTag = async (groupName, groupColor) => {
    const name = (newTagInputs[groupName] || '').trim();
    if (!name) return;
    await createTag(name, groupColor, groupName, groupColor);
    setPendingGroups(prev => prev.filter(g => g.name !== groupName));
    setNewTagInputs(prev => ({ ...prev, [groupName]: '' }));
    load();
  };

  const handleDeleteTag = async (id) => {
    if (!confirm('Remove this tag? It will be removed from all trades.')) return;
    await deleteTag(id);
    load();
  };

  return (
    <div style={s.page}>
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 20 }}>Tags</h2>

      {/* Add group form */}
      <div style={s.card}>
        <div style={{ fontSize: 11, color: '#71717a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 }}>Add Group</div>
        <form onSubmit={handleAddGroup} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            style={s.input}
            placeholder="Group name"
            value={newGroupName}
            onChange={e => setNewGroupName(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {COLORS.map(c => (
              <div key={c} style={{ ...s.swatch, background: c, borderColor: newGroupColor === c ? '#fff' : 'transparent' }} onClick={() => setNewGroupColor(c)} />
            ))}
          </div>
          <button style={s.btn} type="submit">Add Group</button>
        </form>
      </div>

      {/* Groups */}
      {allGroups.map(group => (
        <div key={group.name} style={s.card}>
          <div style={{ ...s.groupHeader, color: group.color }}>
            <div style={s.dot(group.color)} />
            {group.name}
          </div>

          {(group.tags || []).map(tag => (
            <div key={tag.id} style={s.tagRow}>
              <span style={{ ...s.tag, background: group.color + '22', color: group.color }}>{tag.name}</span>
              <button style={s.btnDanger} onClick={() => handleDeleteTag(tag.id)} title="Remove">✕</button>
            </div>
          ))}

          <div style={s.addRow}>
            <input
              style={s.input}
              placeholder={`Add tag to ${group.name}…`}
              value={newTagInputs[group.name] || ''}
              onChange={e => setNewTagInputs(prev => ({ ...prev, [group.name]: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddTag(group.name, group.color); } }}
            />
            <button style={s.btnAdd} onClick={() => handleAddTag(group.name, group.color)}>Add</button>
          </div>
        </div>
      ))}

      {allGroups.length === 0 && (
        <div style={{ color: '#52525b', fontSize: 13, textAlign: 'center', padding: 32 }}>No groups yet — add one above</div>
      )}
    </div>
  );
}
