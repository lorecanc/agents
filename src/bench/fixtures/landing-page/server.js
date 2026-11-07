import http from "node:http"
import fs from "node:fs"
import path from "node:path"

const root = path.dirname(new URL(import.meta.url).pathname)
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" }

http
  .createServer((req, res) => {
    const name = req.url === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "")
    const file = path.join(root, name)
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404)
      res.end("not found")
      return
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" })
    fs.createReadStream(file).pipe(res)
  })
  .listen(Number(process.env.PORT || 4321), "127.0.0.1", () => console.log(`http://127.0.0.1:${process.env.PORT || 4321}`))
