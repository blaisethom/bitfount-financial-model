import { useRef, useEffect, useState } from 'react';

export interface SyncNotification {
  id: string;
  ts: string;
  level: 'info' | 'error';
  msg: string;
}

interface Props {
  notifications: SyncNotification[];
  onClear: () => void;
}

function relTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

export default function NotificationsPanel({ notifications, onClear }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const errorCount = notifications.filter(n => n.level === 'error').length;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        className="btn icon-btn"
        style={{ position: 'relative', minWidth: 32, fontSize: 14 }}
        onClick={() => setOpen(v => !v)}
        title="Sync log"
        aria-label="Sync notifications"
      >
        ⚡
        {errorCount > 0 && (
          <span style={{
            position: 'absolute', top: 2, right: 2,
            background: '#dc2626', color: '#fff',
            borderRadius: '50%', width: 13, height: 13,
            fontSize: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 700, lineHeight: 1,
          }}>
            {errorCount > 9 ? '9+' : errorCount}
          </span>
        )}
      </button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 'calc(100% + 6px)',
          width: 440, maxHeight: 360, overflowY: 'auto',
          background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
          boxShadow: '0 4px 16px rgba(0,0,0,0.12)', zIndex: 200,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '7px 12px', borderBottom: '1px solid #f0f0f0',
            background: '#f9fafb', borderRadius: '8px 8px 0 0', position: 'sticky', top: 0,
          }}>
            <span style={{ fontWeight: 600, fontSize: 12, color: '#374151' }}>Sync log</span>
            {notifications.length > 0 && (
              <button
                onClick={onClear}
                style={{ fontSize: 11, color: '#9ca3af', cursor: 'pointer', background: 'none', border: 'none', padding: '2px 4px' }}
              >
                Clear
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <div style={{ padding: '16px 12px', color: '#9ca3af', fontSize: 12, textAlign: 'center' }}>
              No sync events yet
            </div>
          ) : (
            notifications.map(n => (
              <div key={n.id} style={{
                padding: '6px 12px',
                borderBottom: '1px solid #f5f5f5',
                background: n.level === 'error' ? '#fef2f2' : '#fff',
              }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                  <span style={{ color: n.level === 'error' ? '#dc2626' : '#16a34a', flexShrink: 0, fontWeight: 700, fontSize: 11, marginTop: 1 }}>
                    {n.level === 'error' ? '✗' : '✓'}
                  </span>
                  <span style={{ color: '#374151', fontSize: 11, lineHeight: 1.45, flex: 1, wordBreak: 'break-word', fontFamily: 'monospace' }}>
                    {n.msg}
                  </span>
                  <span style={{ color: '#9ca3af', flexShrink: 0, marginLeft: 4, fontSize: 10, fontFamily: 'sans-serif', whiteSpace: 'nowrap' }}>
                    {relTime(n.ts)}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
