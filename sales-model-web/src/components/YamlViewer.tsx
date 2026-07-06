import { dump as dumpYaml } from 'js-yaml';

interface Props {
  data: unknown;
  /** Ref names to attach anchor IDs to — enables in-page linking. */
  anchorRefs?: Set<string>;
  /** The ref currently being highlighted (plays a brief flash animation). */
  highlightRef?: string;
}

function ScalarValue({ text }: { text: string }) {
  if (text === 'true' || text === 'false' || text === 'null' || text === '~') {
    return <span style={{ color: '#dc2626' }}>{text}</span>;
  }
  if (/^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(text)) {
    return <span style={{ color: '#b45309' }}>{text}</span>;
  }
  if (text.startsWith("'") || text.startsWith('"')) {
    return <span style={{ color: '#15803d' }}>{text}</span>;
  }
  if (text.startsWith('|') || text.startsWith('>') || text.startsWith('!!')) {
    return <span style={{ color: '#9ca3af' }}>{text}</span>;
  }
  return <span style={{ color: '#15803d' }}>{text}</span>;
}

function colorLine(line: string) {
  if (!line.trim()) return <>{line || ''}</>;

  const trimmed = line.trimStart();
  if (trimmed.startsWith('#')) return <span style={{ color: '#9ca3af' }}>{line}</span>;
  if (trimmed === '---' || trimmed === '...') return <span style={{ color: '#9ca3af' }}>{line}</span>;

  // Match: indent + optional "- " + key + ":" + optional " " + optional value
  const m = line.match(/^(\s*)(- )?([^:]+?)(\s*)(: ?)(.*)$/);
  if (m) {
    const [, indent, listMark = '', key, spaceB, colonSep, val] = m;
    return (
      <>
        {indent}
        {listMark && <span style={{ color: '#7c3aed' }}>{listMark}</span>}
        <span style={{ color: '#1d4ed8' }}>{key}</span>
        {spaceB}
        <span style={{ color: '#6b7280' }}>{colonSep}</span>
        {val ? <ScalarValue text={val} /> : null}
      </>
    );
  }

  // List item — plain scalar, no colon
  const listM = line.match(/^(\s*)(- )(.+)$/);
  if (listM) {
    const [, indent, marker, val] = listM;
    return (
      <>
        {indent}
        <span style={{ color: '#7c3aed' }}>{marker}</span>
        <ScalarValue text={val} />
      </>
    );
  }

  return <>{line}</>;
}

/**
 * Return an anchor id for a line if it defines a known ref:
 *   - source block header:  "  <name>:"  (exactly 2-space indent, bare key)
 *   - step list item:       "  - id: <name>"
 */
function anchorIdForLine(line: string, anchorRefs: Set<string>): string | undefined {
  // Source definition — 2-space-indented bare key (under `sources:`)
  const sourceM = line.match(/^  ([a-zA-Z_][a-zA-Z0-9_]*):\s*$/);
  if (sourceM && anchorRefs.has(sourceM[1])) return `yaml-ref-${sourceM[1]}`;

  // Step list item — "  - id: <value>"
  const stepM = line.match(/^  - id: ([^\s]+)\s*$/);
  if (stepM && anchorRefs.has(stepM[1])) return `yaml-ref-${stepM[1]}`;

  return undefined;
}

export default function YamlViewer({ data, anchorRefs, highlightRef }: Props) {
  const yaml = dumpYaml(data, { indent: 2, lineWidth: -1 });
  const lines = yaml.split('\n');
  const highlightId = highlightRef ? `yaml-ref-${highlightRef}` : undefined;

  return (
    <pre className="yaml-viewer">
      {lines.map((line, i) => {
        const anchorId = anchorRefs ? anchorIdForLine(line, anchorRefs) : undefined;
        const isHighlighted = anchorId !== undefined && anchorId === highlightId;
        return (
          <span
            key={i}
            id={anchorId}
            className={isHighlighted ? 'yaml-line-highlight' : undefined}
            style={{ display: 'block' }}
          >
            {colorLine(line)}
          </span>
        );
      })}
    </pre>
  );
}
