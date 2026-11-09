// Session registry: one JSON file per session under <git-common-dir>/opencode-pipeline/sessions.
// Root sessions carry the baseline, the claimed files and the liveness data; child sessions only
// point to their root. Written by the pipeline guard; read by the dev_* tools to attribute work to a root session
// (for example which session owns a service started with dev_serve). Without a registry the readers
// simply find no record.

import fs from "node:fs"
import path from "node:path"
import { pidAlive, safeId } from "./_repo.js"

export const LIVE_TTL_MS = 15 * 60 * 1000

const sessionsDir = (info) => path.join(info.stateDir, "sessions")

export function readSession(info, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionsDir(info), `${safeId(id)}.json`), "utf8"))
  } catch {
    return null
  }
}

export function writeSession(info, rec) {
  // Never resurrect a repository that was removed while the session was running.
  if (!fs.existsSync(info.common)) return
  const dir = sessionsDir(info)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${safeId(rec.sessionId)}.json`)
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(rec))
  fs.renameSync(tmp, file)
}

export function listSessions(info) {
  let names = []
  try {
    names = fs.readdirSync(sessionsDir(info))
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    if (!n.endsWith(".json")) continue
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(sessionsDir(info), n), "utf8")))
    } catch {
      /* ignore partial/corrupt files */
    }
  }
  return out
}

export function deleteSession(info, id) {
  fs.unlinkSync(path.join(sessionsDir(info), `${safeId(id)}.json`))
}

export function isLive(rec, now = Date.now()) {
  return Boolean(rec && rec.busy && pidAlive(rec.pid) && now - (rec.updatedAt || 0) < LIVE_TTL_MS)
}


/** Resolve the root record for a session id (child or root). */
export function rootRecordFor(info, sessionId) {
  const rec = readSession(info, sessionId)
  if (!rec) return null
  if (rec.rootId && rec.rootId !== rec.sessionId) return readSession(info, rec.rootId)
  return rec
}
