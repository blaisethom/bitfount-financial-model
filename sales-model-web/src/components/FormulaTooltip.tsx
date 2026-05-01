interface Props {
  value?: string;
}

export default function FormulaTooltip({ value }: Props) {
  if (!value) return null;
  // Sections separated by blank lines. Lines starting with "$" or a digit/identifier are rendered monospace.
  const sections = value.split('\n\n').map((s) => s.trim()).filter(Boolean);
  return (
    <div className="formula-tooltip">
      {sections.map((sec, i) => {
        const lines = sec.split('\n');
        const heading = lines[0].endsWith(':') ? lines.shift() : null;
        const isCode = sec.includes('=') || sec.includes('Σ');
        return (
          <div key={i} className="ft-section">
            {heading && <div className="ft-heading">{heading}</div>}
            <div className={isCode ? 'ft-code' : 'ft-text'}>
              {lines.map((l, j) => (
                <div key={j}>{l}</div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
