/**
 * 工作区分类的 Host 半边：分类记录的持久化，以及浏览器半边使用的端点。
 *
 * 分类只记"工作区 id → 分类"，工作区本身仍由内置 workspace 域持有；因此本插件
 * 从不改写 `$DSH_HOME/storages/workspace.json`。读取时用 workspaceRegistry 现存
 * 的 id 裁剪失效归属，工作区被删除后分类里不会留孤儿。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 浏览器半边的唯一端点：GET 读、PUT 整份写。 */
const ROUTE = '/api/dsh-workspace-categories/state'
/** 分类文档很小，超出这个体积的请求直接拒绝。 */
const BODY_LIMIT = 256 * 1024

/** 数据文件：沿用 $DSH_HOME/plugin-data/<plugin>/ 约定。 */
function statePath () {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'plugin-data', 'dsh-workspace-categories', 'state.json')
}

/** 读分类文档；首次运行时返回空文档。 */
async function readState (file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return {
      rev: Number.isInteger(parsed.rev) ? parsed.rev : 0,
      categories: Array.isArray(parsed.categories) ? parsed.categories : [],
      assignments: parsed.assignments !== null && typeof parsed.assignments === 'object' ? parsed.assignments : {},
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { rev: 0, categories: [], assignments: {} }
  }
}

/** 原子写入：临时文件 + rename，避免半个文档落盘。 */
async function writeState (file, value) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

/** 规范化分类数组：丢弃没有 id/名称的条目，名称去首尾空格。 */
function normalizeCategories (input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const categories = []
  for (const entry of input) {
    if (typeof entry?.id !== 'string' || entry.id === '' || seen.has(entry.id)) continue
    if (typeof entry?.name !== 'string' || entry.name.trim() === '') continue
    seen.add(entry.id)
    categories.push({ id: entry.id, name: entry.name.trim() })
  }
  return categories
}

/** 只保留"归属到现存分类、且工作区仍存在"的条目。 */
function normalizeAssignments (input, categories, workspaceIds) {
  const known = new Set(categories.map(category => category.id))
  const assignments = {}
  if (input === null || typeof input !== 'object') return assignments
  for (const [workspaceId, categoryId] of Object.entries(input)) {
    if (typeof categoryId !== 'string' || !known.has(categoryId)) continue
    if (workspaceIds !== undefined && !workspaceIds.has(workspaceId)) continue
    assignments[workspaceId] = categoryId
  }
  return assignments
}

/** 写出一个 JSON 响应。 */
function writeJson (res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/** 读取请求体；超过上限时返回 undefined。 */
async function readBody (req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) return undefined
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 只接受本机回环来源：分类是本地视图数据，没有对外的必要。 */
function isLoopback (req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export const inject = ['webServer']

export function apply (ctx) {
  const file = statePath()

  ctx.inject(['webServer', 'workspaceRegistry'], (scoped) => {
    /** 现存工作区 id；分类归属靠它在每次读取时对账。 */
    const liveWorkspaceIds = () => new Set(scoped.workspaceRegistry.list().map(workspace => workspace.id))

    const read = async (_req, res) => {
      const state = await readState(file)
      const assignments = normalizeAssignments(state.assignments, state.categories, liveWorkspaceIds())
      // 工作区被删除（含 ssh 卸载）或分类被删后留下的孤儿：读取时顺手对齐并写回。
      if (Object.keys(assignments).length !== Object.keys(state.assignments).length) {
        await writeState(file, { ...state, assignments })
      }
      writeJson(res, 200, { rev: state.rev, categories: state.categories, assignments })
    }

    const write = async (req, res) => {
      if ((req.headers['content-type'] ?? '').split(';')[0] !== 'application/json') {
        return writeJson(res, 415, { error: 'unsupported media type: PUT requires application/json' })
      }
      const raw = await readBody(req)
      if (raw === undefined) return writeJson(res, 413, { error: 'payload too large' })
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        return writeJson(res, 400, { error: 'invalid JSON body' })
      }
      const state = await readState(file)
      // 两个窗口同时编辑时，后到的整份写入会覆盖先到的：rev 不匹配就要求重读。
      if (body.rev !== state.rev) return writeJson(res, 409, { error: 'stale revision', rev: state.rev })
      const categories = normalizeCategories(body.categories)
      const assignments = normalizeAssignments(body.assignments, categories, liveWorkspaceIds())
      const rev = state.rev + 1
      await writeState(file, { rev, categories, assignments })
      writeJson(res, 200, { rev })
    }

    const route = {
      kind: 'exact',
      path: ROUTE,
      handler: async (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if (req.method === 'GET') return read(req, res)
        if (req.method === 'PUT') return write(req, res)
        writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      },
    }

    scoped.effect(
      () => {
        const dispose = scoped.webServer.register(route)
        return () => dispose()
      },
      'workspace-categories: state route',
    )
  })
}
