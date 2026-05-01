import { useCallback, useEffect, useRef, useState } from 'react';

interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

const MAX_HISTORY = 200;

export function useUndoable<T>(initial: T) {
  const [history, setHistory] = useState<History<T>>({ past: [], present: initial, future: [] });

  const set = useCallback((next: T | ((prev: T) => T)) => {
    setHistory((h) => {
      const computed = typeof next === 'function' ? (next as (prev: T) => T)(h.present) : next;
      if (Object.is(computed, h.present)) return h;
      const past = [...h.past, h.present];
      if (past.length > MAX_HISTORY) past.shift();
      return { past, present: computed, future: [] };
    });
  }, []);

  const reset = useCallback((next: T) => {
    setHistory((h) => {
      if (Object.is(next, h.present)) return h;
      const past = [...h.past, h.present];
      if (past.length > MAX_HISTORY) past.shift();
      return { past, present: next, future: [] };
    });
  }, []);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.past.length === 0) return h;
      const past = h.past.slice(0, -1);
      const present = h.past[h.past.length - 1];
      const future = [h.present, ...h.future];
      return { past, present, future };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((h) => {
      if (h.future.length === 0) return h;
      const [present, ...future] = h.future;
      const past = [...h.past, h.present];
      return { past, present, future };
    });
  }, []);

  // Keep the latest can-undo/can-redo in a ref so the keyboard handler
  // can bail out early without re-binding on every state change.
  const canUndoRef = useRef(false);
  const canRedoRef = useRef(false);
  canUndoRef.current = history.past.length > 0;
  canRedoRef.current = history.future.length > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key !== 'z' && e.key !== 'Z' && e.key !== 'y' && e.key !== 'Y') return;

      // Ignore when an ag-grid cell editor is open — let it handle the key first.
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('.ag-cell-edit-input, .ag-cell-editor, .ag-text-field-input')) return;

      const isRedo = e.key === 'y' || e.key === 'Y' || (e.shiftKey && (e.key === 'z' || e.key === 'Z'));
      if (isRedo) {
        if (canRedoRef.current) {
          e.preventDefault();
          redo();
        }
      } else {
        if (canUndoRef.current) {
          e.preventDefault();
          undo();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  return {
    state: history.present,
    set,
    reset,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    historyDepth: history.past.length,
  };
}
