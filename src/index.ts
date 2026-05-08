import 'dotenv/config'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import { authRouter } from './routes/auth.js'
import { costRouter } from './routes/cost.js'
import { expenseRouter } from './routes/expense.js'
import { openApiDocument } from './openapi/openapi-document.js'
import { getSupabaseConfigStatus } from './supabase.js'

const app = express()
app.use(
  cors({
    origin: true,
    credentials: true,
  }),
)
app.use(cookieParser())
app.use(express.json())

app.get('/openapi.json', (_req, res) => {
  res.json(openApiDocument)
})

app.get('/docs', (_req, res) => {
  res.type('text/html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Costa API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/openapi.json',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'StandaloneLayout',
      persistAuthorization: true,
      displayRequestDuration: true,
    })
  </script>
</body>
</html>`)
})

app.use('/api/auth', authRouter)
app.use('/api/cost', costRouter)
app.use('/api/expenses', expenseRouter)

app.get('/', (_req, res) => {
  res.type('text/plain').send(
    'Costa API — OpenAPI: /docs  raw spec: /openapi.json',
  )
})

app.get('/api/health/supabase', (_req, res) => {
  res.json(getSupabaseConfigStatus())
})

app.get('/api/users/:id', (_req, res) => {
  res.json({ id: _req.params.id })
})

app.get('/api/posts/:postId/comments/:commentId', (_req, res) => {
  res.json({ postId: _req.params.postId, commentId: _req.params.commentId })
})

export default app
