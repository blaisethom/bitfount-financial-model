import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerSourceAdapter } from './engine'
import { hubspotAdapter, hubspotPipelineAdapter } from './engine/sources/hubspot'

// Register engine source adapters once at startup. These are picked up by
// `materializeApiSources` whenever a model declares an `apiSource` with a
// matching adapter id.
registerSourceAdapter(hubspotAdapter);
registerSourceAdapter(hubspotPipelineAdapter);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
