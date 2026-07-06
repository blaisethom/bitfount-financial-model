import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createWriteStream, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { resolve, basename } from 'node:path'
import { streamText, jsonSchema, convertToModelMessages } from 'ai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { load as parseYaml, dump as dumpYaml } from 'js-yaml'
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

// Node.js fetch (undici) ignores HTTPS_PROXY by default. Route it through
// the prokura sidecar so the GEMINI_TOKEN placeholder gets swapped for a real key.
if (process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY) {
  setGlobalDispatcher(new EnvHttpProxyAgent())
}

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
      server.middlewares.use('/api/hubspot/sync', async (_req, res) => {
        try {
          const token = readHubspotToken()
          if (!token) throw new Error('HUBSPOT_API_KEY missing from .env.local')
          const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const api = async (path: string, body?: object): Promise<any> => {
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

// ─── Xero sync plugin ─────────────────────────────────────────────────────
//
// Single endpoint `/api/xero/sync` that fetches invoice data from both orgs
// (Bitfount Inc USD + Bitfount Ltd GBP), converts to USD, and returns
// per-account-code per-month totals from Jan 2026 to the last complete month.
//
// The prokura sidecar intercepts outbound HTTPS transparently at the network
// level, so plain fetch() works — no proxy env var or tunnel needed.
// Prokura swaps the placeholder bearer tokens for real OAuth tokens and
// injects Xero-tenant-id automatically.

function xeroPlugin(): Plugin {
  return {
    name: 'sales-model-xero',
    configureServer(server) {
      server.middlewares.use('/api/xero/sync', async (_req, res) => {
        try {
          const GBP_USD = 1.27

          const xeroFetch =
            (tokenKey: string) =>
            async (path: string): Promise<unknown> => {
              const r = await fetch(`https://api.xero.com${path}`, {
                headers: { Authorization: `Bearer ${tokenKey}`, Accept: 'application/json' },
              })
              if (!r.ok) {
                const body = await r.text()
                throw new Error(`Xero ${path.split('?')[0]} → HTTP ${r.status}: ${body.slice(0, 300)}`)
              }
              return r.json()
            }

          const incFetch = xeroFetch('XERO_TOKEN_BITFOUNT_INC')
          const ltdFetch = xeroFetch('XERO_TOKEN_BITFOUNT_LIMITED')

          // Completed months: Jan 2026 → last complete calendar month
          const today = new Date()
          const lastComplete = new Date(today.getFullYear(), today.getMonth(), 0)
          const lastYear = lastComplete.getFullYear()
          const lastMo = lastComplete.getMonth() + 1
          const completedMonths: string[] = []
          for (let y = 2026, m = 1; y < lastYear || (y === lastYear && m <= lastMo); ) {
            completedMonths.push(`${y}-${String(m).padStart(2, '0')}`)
            if (m === 12) { y++; m = 1 } else { m++ }
          }

          if (completedMonths.length === 0) {
            res.statusCode = 200
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({
              ok: true,
              fetchedAt: new Date().toISOString(),
              gbpUsdRate: GBP_USD,
              completedMonths: [],
              monthly: {},
              accounts: {},
            }))
            return
          }

          const completedSet = new Set(completedMonths)

          // Fetch account metadata for both orgs (code → name/type/class)
          type XeroAccount = { Code?: string; Name: string; Type: string; Class: string }
          const [incAcctsRaw, ltdAcctsRaw] = await Promise.all([
            incFetch('/api.xro/2.0/Accounts') as Promise<{ Accounts?: XeroAccount[] }>,
            ltdFetch('/api.xro/2.0/Accounts') as Promise<{ Accounts?: XeroAccount[] }>,
          ])
          const accounts: Record<string, { name: string; type: string; class: string }> = {}
          for (const acct of [...(incAcctsRaw.Accounts ?? []), ...(ltdAcctsRaw.Accounts ?? [])]) {
            if (acct.Code) accounts[acct.Code] = { name: acct.Name, type: acct.Type, class: acct.Class }
          }

          // Aggregate invoice line items into monthly × account-code totals (USD)
          const monthly: Record<string, Record<string, number>> = {}

          type XeroLine = { AccountCode?: string; LineAmount?: number }
          type XeroInvoice = { Type?: string; DateString?: string; LineItems?: XeroLine[] }
          type XeroInvoicesResp = { Invoices?: XeroInvoice[] }

          const whereEnc = encodeURIComponent(
            'Date>=DateTime(2026,1,1) AND Status!="DELETED" AND Status!="VOIDED"',
          )

          async function fetchAllInvoices(
            fetchFn: (path: string) => Promise<unknown>,
            fxRate: number,
          ): Promise<void> {
            for (let page = 1; page <= 50; page++) {
              const data = (await fetchFn(
                `/api.xro/2.0/Invoices?where=${whereEnc}&page=${page}`,
              )) as XeroInvoicesResp
              const invs = data.Invoices ?? []
              if (invs.length === 0) break
              for (const inv of invs) {
                const month = (inv.DateString ?? '').slice(0, 7)
                if (!month || !completedSet.has(month)) continue
                for (const line of inv.LineItems ?? []) {
                  const code = line.AccountCode
                  if (!code) continue
                  const amt = (line.LineAmount ?? 0) * fxRate
                  if (amt === 0) continue
                  if (!monthly[month]) monthly[month] = {}
                  monthly[month][code] = (monthly[month][code] ?? 0) + amt
                }
              }
              if (invs.length < 100) break
            }
          }

          await Promise.all([
            fetchAllInvoices(incFetch, 1.0),
            fetchAllInvoices(ltdFetch, GBP_USD),
          ])

          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({
            ok: true,
            fetchedAt: new Date().toISOString(),
            gbpUsdRate: GBP_USD,
            completedMonths,
            monthly,
            accounts,
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

// ─── AI assistant plugin ──────────────────────────────────────────────────
//
// POST /api/ai/chat — streaming Gemini endpoint used by the AI sidebar.
// The client uploads its tool schemas in the request body; we convert them
// to AI SDK tools (no execute = client-side execution via useAssistantTool).
// The prokura sidecar intercepts calls to generativelanguage.googleapis.com
// and swaps GEMINI_TOKEN for the real key automatically.

function aiPlugin(): Plugin {
  return {
    name: 'sales-model-ai',
    configureServer(server) {
      server.middlewares.use('/api/ai/chat', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }

        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        await new Promise<void>((r) => req.on('end', r))
        // body.tools: Record<string, { description?: string; parameters: JSONSchema7 }>
        // body.messages: UIMessage[] from @ai-sdk/react useChat
        type RawToolDef = { description?: string; parameters: Record<string, unknown> }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          messages?: import('ai').UIMessage[]
          system?: string
          tools?: Record<string, RawToolDef>
        }

        console.log(`[ai] ${body.messages?.length ?? 0} messages, tools: ${Object.keys(body.tools ?? {}).join(', ') || 'none'}, system: ${body.system?.length ?? 0}ch`)
        if ((body.messages?.length ?? 0) > 1) {
          console.log('[ai] multi-turn messages:', JSON.stringify(body.messages?.map(m => ({ role: m.role, parts: m.parts?.map((p: Record<string, unknown>) => p.type), pmKeys: Object.keys((m as Record<string, unknown>).providerMetadata ?? {}) }))))
        }

        const google = createGoogleGenerativeAI({ apiKey: 'GEMINI_TOKEN' })

        // Each tool entry from the client is { description, parameters: JSONSchema7 }.
        // We extract the parts separately so the AI SDK can declare them correctly.
        const toolEntries = Object.entries(body.tools ?? {}).map(([name, t]) => [
          name,
          {
            description: t.description,
            parameters: jsonSchema(t.parameters as Parameters<typeof jsonSchema>[0]),
          },
        ])

        const abortController = new AbortController()
        req.on('close', () => abortController.abort())
        const timeout = setTimeout(() => abortController.abort(), 60_000)

        try {
          const modelMessages = await convertToModelMessages(body.messages ?? [])
          console.log(`[ai] converted to ${modelMessages.length} model messages`)
          const result = streamText({
            model: google('gemini-2.5-flash'),
            system: body.system ?? 'You are a helpful assistant for a financial model.',
            messages: modelMessages,
            tools: toolEntries.length ? Object.fromEntries(toolEntries) : undefined,
            maxSteps: 5,
            abortSignal: abortController.signal,
            onError: (event) => { console.error('[ai] streamText error:', event.error) },
          })

          const response = result.toUIMessageStreamResponse()
          res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
          if (response.body) {
            const readable = Readable.fromWeb(
              response.body as import('node:stream/web').ReadableStream,
            )
            readable.on('error', (err) => console.error('[ai] stream pipe error:', err))
            res.on('error', (err) => console.error('[ai] res error (client disconnected):', err))
            readable.pipe(res)
          }
        } catch (err) {
          clearTimeout(timeout)
          console.error('[ai] error:', err)
          if (!res.headersSent) {
            res.statusCode = 500
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
          }
          return
        }
        clearTimeout(timeout)
      })
    },
  }
}

// ─── Layout save plugin ───────────────────────────────────────────────────────
//
// POST /api/layout/save — writes an edited layout object back to its YAML file.
// Body: { file: 'web' | 'rendering' | 'engine', data: object }
// The object is serialised with js-yaml's dump() and written to
// src/view-layout/<file>.yaml, then Vite's HMR reloads the module.

function layoutPlugin(): Plugin {
  const ALLOWED = new Set(['web', 'rendering', 'engine'])
  return {
    name: 'sales-model-layout',
    configureServer(server) {
      server.middlewares.use('/api/layout/save', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        await new Promise<void>((r) => req.on('end', r))
        try {
          const { file, data } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            file: string
            data: unknown
          }
          if (!ALLOWED.has(file)) throw new Error(`Unknown layout file: ${file}`)
          let filePath: string
          let yaml: string
          if (file === 'web') {
            // Tabs live inside report.yaml — patch just the `tabs` key.
            filePath = resolve(__dirname, 'src/report/report.yaml')
            const existing = parseYaml(readFileSync(filePath, 'utf8')) as Record<string, unknown>
            existing.tabs = (data as { tabs: unknown }).tabs
            yaml = '# Report and web tab definitions. Edit via Rendering > Report Definition or directly.\n\n' +
              dumpYaml(existing, { indent: 2, lineWidth: -1, noRefs: true })
          } else {
            filePath = resolve(__dirname, `src/view-layout/${file}.yaml`)
            const header = file === 'rendering'
              ? '# Rendering section tab layout.\n\n'
              : '# Engine section layout — groups and headline outputs.\n\n'
            yaml = header + dumpYaml(data, { indent: 2, lineWidth: -1, noRefs: true })
          }
          writeFileSync(filePath, yaml, 'utf8')
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true }))
        } catch (err) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        }
      })
    },
  }
}

function reportPlugin(): Plugin {
  const saveReport = (filePath: string, header: string, data: unknown, res: import('http').ServerResponse) => {
    const yaml = header + dumpYaml(data, { indent: 2, lineWidth: -1, noRefs: true })
    writeFileSync(filePath, yaml, 'utf8')
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
  }
  return {
    name: 'sales-model-report',
    configureServer(server) {
      server.middlewares.use('/api/report/save', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        await new Promise<void>((r) => req.on('end', r))
        try {
          const { data } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data: unknown }
          saveReport(
            resolve(__dirname, 'src/report/report.yaml'),
            '# Report section definitions. Edit via Rendering > Report Definition or directly.\n\n',
            data, res,
          )
        } catch (err) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        }
      })
      server.middlewares.use('/api/cashflow-report/save', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        await new Promise<void>((r) => req.on('end', r))
        try {
          const { data } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data: unknown }
          saveReport(
            resolve(__dirname, 'src/report/cashflow_report.yaml'),
            '# Cashflow report section definitions.\n\n',
            data, res,
          )
        } catch (err) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        }
      })
    },
  }
}

function yamlZipPlugin(): Plugin {
  const YAML_FILES = [
    { path: resolve(__dirname, 'src/report/report.yaml'), name: 'report.yaml' },
    { path: resolve(__dirname, 'src/view-layout/engine.yaml'), name: 'engine.yaml' },
  ]
  return {
    name: 'sales-model-yaml-zip',
    configureServer(server) {
      server.middlewares.use('/api/yaml/export', async (_req, res) => {
        try {
          const JSZip = (await import('jszip')).default
          const zip = new JSZip()
          for (const { path, name } of YAML_FILES) {
            if (existsSync(path)) zip.file(name, readFileSync(path, 'utf8'))
          }
          const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
          res.statusCode = 200
          res.setHeader('content-type', 'application/zip')
          res.setHeader('content-disposition', 'attachment; filename="model-config.zip"')
          res.end(buf)
        } catch (err) {
          res.statusCode = 500
          res.end(String(err))
        }
      })

      server.middlewares.use('/api/yaml/import', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        await new Promise<void>((r) => req.on('end', r))
        try {
          const JSZip = (await import('jszip')).default
          const zip = await JSZip.loadAsync(Buffer.concat(chunks))
          const byName = Object.fromEntries(YAML_FILES.map(f => [f.name, f.path]))
          const written: string[] = []
          for (const [entryName, file] of Object.entries(zip.files)) {
            if (file.dir) continue
            const base = entryName.split('/').pop() ?? entryName
            if (byName[base]) {
              writeFileSync(byName[base], await file.async('string'), 'utf8')
              written.push(base)
            }
          }
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true, written }))
        } catch (err) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: String(err) }))
        }
      })
    },
  }
}

function yamlPlugin(): Plugin {
  return {
    name: 'vite-yaml',
    transform(src, id) {
      if (!id.endsWith('.yaml') && !id.endsWith('.yml')) return
      const parsed = parseYaml(src)
      return { code: `export default ${JSON.stringify(parsed)}`, map: null }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), react(), yamlPlugin(), layoutPlugin(), reportPlugin(), yamlZipPlugin(), uploadPlugin(), hubspotPlugin(), xeroPlugin(), aiPlugin()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
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
