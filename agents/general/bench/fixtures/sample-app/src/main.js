import http from "node:http"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error("Missing required environment variable DATABASE_URL")
  process.exit(1)
}

const server = http.createServer((req, res) => {
  res.writeHead(404)
  res.end("not found")
})

server.listen(Number(process.env.PORT || 3000), "127.0.0.1", () => {
  console.log("listening")
})
