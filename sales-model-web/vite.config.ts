import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createWriteStream, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve, basename } from 'node:path'

const UPLOAD_DIR = resolve(__dirname, 'uploads')

const SALES_PIPELINE_ID = '692322095'
const CHANGE_ORDERS_PIPELINE_ID = '698625200'
const DEAL_PROPS = [
  'dealname', 'dealstage', 'pipeline', 'closedate', 'createdate', 'amount',
  'project_duration__months_', 'customer_type', 'cro_type', 'study_phase',
  'project_type', 'change_order_amount', 'has_change_order_',
  // Candidate disease / TA properties — HubSpot returns the ones that exist
  // and silently omits the rest. `resolveDealTA` currently uses deal name
  // matching only; these are here so the UI shows them when present and we
  // can wire them into the allocator later without another backend change.
  'therapeutic_area', 'disease', 'indication', 'disease_area', 'study_indication',
]
const LI_PROPS = ['name', 'price', 'quantity', 'amount']

function readHubspotToken(): string | null {
  const path = resolve(__dirname, '.env.local')
  if (!existsSync(path)) return null
  const m = /^HUBSPOT_API_KEY=(.+?)\s*$/m.exec(readFileSync(path, 'utf8'))
  return m ? m[1].trim() : null
}

function hubspotPlugin(): Plugin {
  return {
    name: 'sales-model-hubspot',
    configureServer(server) {
      server.middlewares.use('/api/hubspot/sync', async (req, res) => {
        try {
          const token = readHubspotToken()
          if (!token) throw new Error('HUBSPOT_API_KEY missing from .env.local')
          const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }
          const api = async (path: string, body?: object) => {
            const r = await fetch(`https://api.hubapi.com${path}`, {
              method: body ? 'POST' : 'GET',
              headers,
              body: body ? JSON.stringify(body) : undefined,
            })
            if (!r.ok) throw new Error(`HubSpot ${path} → HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`)
            return r.json()
          }

          const pipelinesRaw = await api('/crm/v3/pipelines/deals')
          const pipelines: Record<string, { id: string; label: string; stages: Record<string, string> }> = {}
          for (const p of pipelinesRaw.results) {
            if (p.id !== SALES_PIPELINE_ID && p.id !== CHANGE_ORDERS_PIPELINE_ID) continue
            pipelines[p.id] = {
              id: p.id,
              label: p.label,
              stages: Object.fromEntries(p.stages.map((s: { id: string; label: string }) => [s.id, s.label])),
            }
          }

          const fetchDeals = async (pipelineId: string) => {
            const out: Array<{ id: string; properties: Record<string, string | null> }> = []
            let after: string | undefined
            for (let page = 0; page < 100; page++) {
              const body: Record<string, unknown> = {
                filterGroups: [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: pipelineId }] }],
                properties: DEAL_PROPS,
                limit: 100,
              }
              if (after) body.after = after
              const r = await api('/crm/v3/objects/deals/search', body)
              for (const d of r.results) out.push({ id: d.id, properties: d.properties })
              after = r.paging?.next?.after
              if (!after) break
            }
            return out
          }

          const salesDeals = await fetchDeals(SALES_PIPELINE_ID)
          const coDeals = await fetchDeals(CHANGE_ORDERS_PIPELINE_ID)
          const allDeals = [...salesDeals, ...coDeals]

          // Batch-fetch line item associations for every deal
          const liByDeal: Record<string, string[]> = {}
          for (let i = 0; i < allDeals.length; i += 100) {
            const chunk = allDeals.slice(i, i + 100)
            const r = await api('/crm/v4/associations/deals/line_items/batch/read', {
              inputs: chunk.map((d) => ({ id: d.id })),
            })
            for (const item of r.results) {
              liByDeal[String(item.from.id)] = item.to.map((t: { toObjectId: number }) => String(t.toObjectId))
            }
          }

          // Batch-read all line items
          const allLiIds = Array.from(new Set(Object.values(liByDeal).flat()))
          const lineItems: Record<string, Record<string, string | null>> = {}
          for (let i = 0; i < allLiIds.length; i += 100) {
            const chunk = allLiIds.slice(i, i + 100)
            const r = await api('/crm/v3/objects/line_items/batch/read', {
              properties: LI_PROPS,
              inputs: chunk.map((id) => ({ id })),
            })
            for (const li of r.results) lineItems[String(li.id)] = li.properties
          }

          // Compose response: deal with its line items inlined
          const deals = allDeals.map((d) => ({
            id: d.id,
            properties: d.properties,
            lineItems: (liByDeal[d.id] || []).map((id) => ({ id, ...lineItems[id] })),
          }))

          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({
            ok: true,
            fetchedAt: new Date().toISOString(),
            pipelines,
            deals,
            counts: {
              sales: salesDeals.length,
              changeOrders: coDeals.length,
              lineItems: allLiIds.length,
            },
          }))
        } catch (err) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        }
      })
    },
  }
}

function uploadPlugin(): Plugin {
  return {
    name: 'sales-model-upload',
    configureServer(server) {
      mkdirSync(UPLOAD_DIR, { recursive: true })
      server.middlewares.use('/api/upload', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method Not Allowed')
          return
        }
        const raw = String(req.headers['x-filename'] ?? 'upload.bin')
        const safe = basename(raw).replace(/[^\w.\- ]/g, '_').slice(0, 200) || 'upload.bin'
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const target = resolve(UPLOAD_DIR, `${stamp}__${safe}`)
        const out = createWriteStream(target)
        req.pipe(out)
        out.on('finish', () => {
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true, saved: target }))
        })
        out.on('error', (err) => {
          res.statusCode = 500
          res.end(String(err))
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), uploadPlugin(), hubspotPlugin()],
  server: {
    host: true,
    port: 3000,
    allowedHosts: ['finmodel.agent.ribiseln.com'],
  },
  preview: {
    host: true,
    port: 3000,
    allowedHosts: ['finmodel.agent.ribiseln.com'],
  },
})
