import { Hono } from 'hono'
import { env } from 'hono/adapter'

const imagesRoute = new Hono()

// In-memory store for tracking image generation requests
const imageRequestStore = new Map<string, {
  status: string,
  retryCount: number,
  lastChecked: number
}>()

// Route for generating images
imagesRoute.post('/generate', async (c) => {
  try {
    console.log('🎨 Received image generation request')
    const { prompt } = await c.req.json()
    
    if (!prompt) {
      console.log('⚠️ Missing prompt in request')
      return c.json({ error: 'Prompt is required' }, 400)
    }

    // Get environment variables
    const { IMAGINE_API_TOKEN } = env<{ IMAGINE_API_TOKEN: string }>(c)
    console.log('🔑 Retrieved API token:', IMAGINE_API_TOKEN.slice(0,10) + '...')

    // Call Midjourney API to generate image
    console.log('🚀 Calling API to generate image')
    console.log('📝 Prompt:', prompt)
    const response = await fetch('http://localhost:8055/items/images/', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${IMAGINE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt: `https://s.mj.run/YLJMlMJbo70 ${prompt}` })
    })

    if (!response.ok) {
      console.log('❌ API call failed with status:', response.status)
      console.log('❌ Status text:', response.statusText)
      throw new Error(`Image generation failed: ${response.statusText}`)
    }

    const data = await response.json()
    const imageId = data.data.id
    console.log('📝 Image generation initiated')
    console.log('🆔 Image ID:', imageId)
    console.log('📊 Full response:', JSON.stringify(data, null, 2))

    // Initialize request tracking
    imageRequestStore.set(imageId, {
      status: 'pending',
      retryCount: 0,
      lastChecked: Date.now()
    })

    // Poll for image status
    const maxRetries = 5
    const backoffMs = 5000

    while (true) {
      const requestInfo = imageRequestStore.get(imageId)
      if (!requestInfo) {
        throw new Error('Lost track of image request')
      }

      if (requestInfo.retryCount >= maxRetries) {
        console.log('❌ Max retries exceeded')
        imageRequestStore.delete(imageId)
        throw new Error('Image generation timed out after max retries')
      }

      console.log(`\n⏳ Checking image status (attempt ${requestInfo.retryCount + 1}/${maxRetries})`)
      console.log('⏰ Waiting for', backoffMs * Math.pow(2, requestInfo.retryCount), 'ms')
      await new Promise(resolve => setTimeout(resolve, backoffMs * Math.pow(2, requestInfo.retryCount)))

      const statusResponse = await fetch(`http://localhost:8055/items/images/${imageId}`, {
        headers: {
          'Authorization': `Bearer ${IMAGINE_API_TOKEN}`
        }
      })

      if (!statusResponse.ok) {
        console.log('❌ Status check failed:', statusResponse.status)
        console.log('❌ Status text:', statusResponse.statusText)
        imageRequestStore.delete(imageId)
        throw new Error(`Failed to check status: ${statusResponse.statusText}`)
      }

      const statusData = await statusResponse.json()
      const currentStatus = statusData.data.status
      console.log(`📊 Current status: ${currentStatus}`)
      console.log('📊 Full status data:', JSON.stringify(statusData, null, 2))

      // Update stored status
      imageRequestStore.set(imageId, {
        ...requestInfo,
        status: currentStatus,
        lastChecked: Date.now()
      })

      if (currentStatus === 'failed') {
        console.log('⚠️ Generation attempt failed')
        console.log('🔄 Retrying...')
        console.log('📊 Failure details:', JSON.stringify(statusData.data.error || {}, null, 2))
        imageRequestStore.set(imageId, {
          ...requestInfo,
          retryCount: requestInfo.retryCount + 1
        })
        continue
      }

      if (currentStatus === 'completed') {
        console.log('✨ Image generation completed')
        console.log('📥 Fetching final image details')
        
        // Clean up tracking
        imageRequestStore.delete(imageId)
        
        return c.json({
          status: 'success',
          data: {
            id: imageId,
            status: 'completed',
            url: statusData.data.url,
            upscaledUrls: statusData.data.upscaled_urls
          }
        })
      }

      // For any other status, continue polling
      imageRequestStore.set(imageId, {
        ...requestInfo,
        retryCount: requestInfo.retryCount + 1
      })
    }

  } catch (error: any) {
    console.error('❌ Error generating image:', error)
    console.error('📊 Error details:', error.stack)
    return c.json({ 
      error: 'Failed to generate image',
      details: error.message,
      stack: error.stack
    }, 500)
  }
})

export default imagesRoute
