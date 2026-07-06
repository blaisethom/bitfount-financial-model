import { Component, StrictMode } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerSourceAdapter } from './engine'
import { hubspotAdapter, hubspotPipelineAdapter } from './engine/sources/hubspot'
import { xeroActualsAdapter, xeroCostLineAdapter } from './engine/sources/xero'

// Register engine source adapters once at startup. These are picked up by
// `materializeApiSources` whenever a model declares an `apiSource` with a
// matching adapter id.
registerSourceAdapter(hubspotAdapter);
registerSourceAdapter(hubspotPipelineAdapter);
registerSourceAdapter(xeroActualsAdapter);
registerSourceAdapter(xeroCostLineAdapter);

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }
  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div style={{ fontFamily: 'monospace', padding: '2rem', maxWidth: '800px', margin: '0 auto' }}>
          <h2 style={{ color: '#c00', marginBottom: '0.5rem' }}>Application error</h2>
          <pre style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '6px', padding: '1rem', fontSize: '13px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {error.message}
            {error.stack ? '\n\n' + error.stack : ''}
          </pre>
          <button
            style={{ marginTop: '1rem', padding: '0.4rem 1rem', fontSize: '13px', cursor: 'pointer' }}
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
