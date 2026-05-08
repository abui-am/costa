import 'dotenv/config'
import app from './index.js'

const port =
  typeof process.env.PORT !== 'undefined' && process.env.PORT !== ''
    ? Number(process.env.PORT)
    : 3222
const host = process.env.HOST?.trim() || '0.0.0.0'

if (Number.isNaN(port)) {
  console.error('Invalid PORT', process.env.PORT)
  process.exit(1)
}

const server = app.listen(port, host, () => {
  console.info(`HTTP listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`)
  console.info(`Swagger UI: http://localhost:${port}/docs`)
})

server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(err)
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${String(port)} is already in use. Stop the other process (e.g. lsof -iTCP:${String(port)}) or run: PORT=3000 npm start`,
    )
  }
  process.exit(1)
})
