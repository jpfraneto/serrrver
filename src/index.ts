import { serve } from 'bun'
import * as dotenv from 'dotenv'
dotenv.config({ path: '.env' })
import {cors} from 'hono/cors'
import doppelgangerRoute from './routes/doppelganger/index'
import { Hono } from 'hono'
import imagesRoute from './routes/images/index'
import ankyRoute from './routes/anky/index'
import appreciationRoute from './routes/appreciation/index'
import a0xbotRoute from './routes/a0xbot/index'
console.log('🚀 Initializing Hono app...')
const app = new Hono()

console.log('🔒 Setting up CORS...')
app.use('*',cors({
  origin: ['https://frame.anky.bot', 'https://anky.bot', 'https://appreciation.lat', 'https://doppelganger.lat', 'https://fartwins.lat'],
  allowHeaders: ['Authorization', 'Origin', 'Content-Type', 'Accept'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['Authorization', 'Origin', 'Content-Type', 'Accept'],
  maxAge: 222 // Add timeout config
}))

console.log('🛣️ Setting up routes...')
// routes
app.route('/images', imagesRoute)
app.route('/anky', ankyRoute)
app.route('/doppelganger', doppelgangerRoute)
app.route('/appreciation', appreciationRoute)
app.route('/a0xbot', a0xbotRoute)

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

console.log('🌐 Starting server...')
serve({
  fetch: app.fetch,
  port: 4444,
  development: false,
  idleTimeout: 250                           
})