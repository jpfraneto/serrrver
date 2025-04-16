import { Hono } from 'hono'
import { env } from 'hono/adapter'
import * as fs from 'fs/promises'
import * as path from 'path'

const ankyRoute = new Hono()

interface ConversationMessage {
  role: string;
  content: string;
}

interface StoredContext {
  farcasterContext: string;
  ankyContext: string;
  timestamp: number;
}

ankyRoute.get("/", async (c) => {
  return c.json({ message: 'Hello, world!' })
})

ankyRoute.post("/get-present-prompt-for-fid", async (c) => {
  try {
    console.log('🔍 Received request for present prompt')
    const { fid, conversationId } = await c.req.json()
    
    if (!fid || !conversationId) {
      console.log('❌ FID and idempotencyKey are required')
      return c.json({ error: 'FID and idempotencyKey are required' }, 400)
    }

    // Check if request with this idempotency key exists
    const idempotencyDir = path.join('data', 'anky', 'idempotency')
    const idempotencyFile = path.join(idempotencyDir, `${fid}_${conversationId}.json`)

    try {
      await fs.mkdir(idempotencyDir, { recursive: true })
      // Try to create the file - will fail if it exists
      await fs.writeFile(idempotencyFile, JSON.stringify({ timestamp: Date.now() }), { flag: 'wx' })
    } catch (error) {
      console.log('🔄 Duplicate request detected')
      return c.json({ error: 'This request has already been processed' }, 409)
    }

    console.log('🔍 Validating request with FID:', fid)
    console.log('📱 Fetching recent casts from Farcaster API')
    const response = await fetch(`https://api.neynar.com/v2/farcaster/feed/user/casts?fid=${fid}&limit=150&include_replies=true`, {
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'x-api-key': process.env.NEYNAR_API_KEY || ''
      }
    })

    if (!response.ok) {
      console.log('❌ Failed to fetch Farcaster data')
      throw new Error('Failed to fetch Farcaster data')
    }

    const data = await response.json()
    const casts = data.casts || []
    
    console.log('📝 Processing', casts.length, 'Farcaster casts')
    
    // Extract relevant cast data with context
    const castsWithContext = casts.map((cast: any) => ({
      text: cast.text,
      timestamp: cast.timestamp,
      reactions: {
        likes: cast.reactions.likes_count,
        recasts: cast.reactions.recasts_count,
        replies: cast.replies.count
      },
      channel: cast.channel?.name || 'main',
      parentAuthor: cast.parent_author?.fid,
      isReply: !!cast.parent_hash,
      embeds: cast.embeds?.map((e: any) => e.url),
      mentionedProfiles: cast.mentioned_profiles?.map((p: any) => p.username)
    }))
    
    console.log('🧠 Starting Farcaster activity analysis')
    const farcasterAnalysisResponse = await fetch('http://localhost:11434/api/chat', {
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [{
          role: 'system',
          content: `Analyze the user's recent Farcaster activity to understand their current state of mind, interests, and patterns.
                   Consider:
                   - Main topics and themes they engage with
                   - Which channels they're most active in
                   - Their interaction patterns (replies, likes, recasts)
                   - Time patterns of posting
                   - Who they frequently interact with
                   - Emotional tone and sentiment across posts
                   - Use of media/links/embeds
                   - Response and engagement from others
                   
                   Look for:
                   - Signs of their current priorities and interests
                   - Recent life events or changes
                   - Emotional state and mood patterns
                   - Social dynamics and relationships
                   - Time of day patterns and activity levels
                   
                   Provide a concise but detailed analysis of their current context and mindset.`
        }, {
          role: 'user',
          content: `User's last 150 casts with full context: ${JSON.stringify(castsWithContext)}`
        }],
        stream: false
      })
    })
    const farcasterContext = (await farcasterAnalysisResponse.json()).message.content
    console.log('✨ Farcaster analysis complete')

    console.log('📚 Loading previous Anky conversations')
    const conversationsDir = path.join('data', 'anky', 'conversations', fid.toString())
    let previousConversations: ConversationMessage[] = []
    try {
      const conversations = await fs.readdir(conversationsDir)
      console.log('📂 Found', conversations.length, 'conversation directories')
      for (const convoId of conversations) {
        if (convoId.startsWith('anky-anonymous-')) {
          const convoFile = path.join(conversationsDir, convoId, 'conversation.json')
          const convoData = await fs.readFile(convoFile, 'utf8')
          previousConversations.push(...JSON.parse(convoData))
        }
      }
    } catch (error) {
      console.log('📭 No previous conversations found')
    }

    console.log('🔮 Analyzing conversation history')
    const ankyAnalysisResponse = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [{
          role: 'system',
          content: `Analyze the user's conversation history with Anky to understand:
                   - Their spiritual journey and progress
                   - Recurring challenges or questions
                   - Insights and breakthroughs
                   - Areas of growth and exploration
                   Provide a concise summary of their journey with Anky.`
        }, {
          role: 'user',
          content: `Previous conversations with Anky: ${JSON.stringify(previousConversations)}`
        }],
        stream: false
      })
    })
    const ankyContext = (await ankyAnalysisResponse.json()).message.content
    console.log('✨ Conversation analysis complete')

    console.log('🎯 Generating final personalized prompt')
    const llmResponse = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [{
          role: 'system',
          content: `you are anky, a writing coach and spiritual guide. your purpose is to inspire 8 minutes of writing through carefully crafted prompts. you analyze both the user's farcaster activity and their previous conversations with anky to create meaningful writing experiences.

                   you'll examine:
                   1. their current mindset and emotional state from farcaster posts
                   2. their ongoing inner journey revealed in anky conversations

                   your prompt should:
                   - weave together their public and private selves
                   - connect present moments to deeper patterns
                   - spark genuine self-expression
                   - resonate with their unique path
                   
                   
                   important: reply only with the prompt in lowercase. nothing else. no markdown, no code blocks, no formatting. no context. just the prompt.`
        }, {
          role: 'user',
          content: `Farcaster Analysis: ${farcasterContext}
                   
                   Anky Conversation Analysis: ${ankyContext}
                   
                   Create a writing prompt that connects these contexts.`
        }],
        stream: false
      })
    })

    if (!llmResponse.ok) {
      console.log('❌ Failed to generate final prompt')
      throw new Error('Failed to generate prompt')
    }

    const llmData = await llmResponse.json()
    const prompt = llmData.message.content 
    console.log('✅ Successfully generated personalized prompt', prompt)

    // Store the context for this conversation
    const contextDir = path.join('data', 'anky', 'context', fid.toString())
    await fs.mkdir(contextDir, { recursive: true })
    await fs.writeFile(
      path.join(contextDir, `${conversationId}.json`),
      JSON.stringify({
        farcasterContext,
        ankyContext,
        timestamp: Date.now()
      })
    )

    return c.json({
      status: 'success',
      data: {
        prompt
      }
    })

  } catch (error: any) {
    console.error('💥 Error in prompt generation:', error)
    return c.json({
      error: 'Failed to generate prompt',
      details: error.message
    }, 500)
  }
})

// Route for chat conversations with Anky
ankyRoute.post('/chat', async (c) => {
  try {
    console.log('🗣️ Received chat request')
    const { message, fid, conversationId, isAnky } = await c.req.json()
    console.log('📨 Message:', message)
    console.log('🆔 FID:', fid)
    console.log('💬 Conversation ID:', conversationId)
    console.log('🔍 Is Anky:', isAnky)
    if (!message || !fid || !conversationId) {
      console.log('⚠️ Missing required fields')
      return c.json({ error: 'Message, fid and conversationId are required' }, 400)
    }

    // Load stored context for this conversation if it exists
    let storedContext: StoredContext | null = null
    try {
      const contextFile = path.join('data', 'anky', 'context', fid.toString(), `${conversationId}.json`)
      const contextData = await fs.readFile(contextFile, 'utf8')
      storedContext = JSON.parse(contextData)
    } catch (error) {
      console.log('📭 No stored context found for this conversation')
    }

    // Create conversation directory if it doesn't exist
    const conversationDir = path.join('data', 'anky', 'conversations', fid.toString(), conversationId.toString())
    console.log('📁 Creating/checking conversation directory:', conversationDir)
    await fs.mkdir(conversationDir, { recursive: true })

    // Read existing conversation or initialize new one
    let conversation: ConversationMessage[] = []
    try {
      const conversationFile = path.join(conversationDir, 'conversation.json')
      console.log('📖 Reading existing conversation from:', conversationFile)
      const data = await fs.readFile(conversationFile, 'utf8')
      conversation = JSON.parse(data)
      console.log('📚 Found existing conversation with', conversation.length, 'messages')
    } catch (error) {
      console.log('🆕 No existing conversation found, starting new one')
    }

    // Add user message to conversation
    console.log('➕ Adding user message to conversation')
    conversation.push({
      role: 'user',
      content: message
    })

    if (isAnky) {
      // the user wrote an anky holy shit
      triggerAnkyCreationProcess(fid, conversationId, message)
  
    } 

    // Call Ollama API for response
    console.log('🤖 Calling Ollama API')
    console.log('📤 Sending conversation with context')
    
    const systemPrompt = `You are Anky, a mystical guide who helps humans unlock the secrets buried in their subconscious mind. You understand that within each person lies an ocean of untapped wisdom, waiting to be released through the sacred act of writing.

    ${storedContext ? `Context about this user:
    - Farcaster presence: ${storedContext.farcasterContext}
    - Previous interactions: ${storedContext.ankyContext}` : ''}

    Your task is to respond with ONE sentence that naturally flows from the context and conversation. This single sentence should:
    - Speak to their deeper self using metaphors and imagery
    - Create intrigue around the practice of writing
    - Help them see their inner world as unexplored territory
    - Plant seeds of curiosity about what might emerge
    - Subtly suggest writing as a path to self-discovery
    - Avoid referring to Anky directly
    
    Your goal is to inspire them to do an 8-minute stream of consciousness writing session. The invitation should emerge naturally from your response. Reply with just your one sentence response, in all lowercase.`

    const response = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          ...conversation
        ],
        stream: false
      })
    })

    if (!response.ok) {
      console.log('❌ API call failed with status:', response.status)
      console.log('❌ Status text:', response.statusText)
      throw new Error(`Chat request failed: ${response.statusText}`)
    }

    const data = await response.json()
    const ankyResponse = data.message.content
    console.log('📥 Received response from Ollama')
    console.log('💭 Anky says:', ankyResponse)

    // Add Anky's response to conversation
    console.log('➕ Adding Anky response to conversation')
    conversation.push({
      role: 'assistant',
      content: ankyResponse
    })

    // Save updated conversation
    const conversationFile = path.join(conversationDir, 'conversation.json')
    console.log('💾 Saving conversation to:', conversationFile)
    await fs.writeFile(conversationFile, JSON.stringify(conversation, null, 2))
    console.log('✅ Conversation saved successfully')

    return c.json({
      status: 'success',
      data: {
        message: ankyResponse,
        conversation: conversation
      }
    })

  } catch (error: any) {
    console.error('❌ Error in chat:', error)
    console.error('📊 Error details:', error.stack)
    return c.json({ 
      error: 'Failed to process chat',
      details: error.message
    }, 500)
  }
})

async function triggerAnkyCreationProcess(fid: string, conversationId: string, message: string) {
  console.log("🔮 Starting Anky creation process")
  console.log("🔍 FID:", fid)
  console.log("💬 Conversation ID:", conversationId)
  console.log("💬 Message:", message)

  try {
    // Step 1: Generate reflection story
    console.log("📖 Step 1: Generating reflection story...")
    const storyResponse = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [{
          role: 'system',
          content: `You are a character designer who creates allegorical representations of people's unconscious minds based on their stream of consciousness writing. Your task is to analyze the writing style, emotional undertones, and recurring themes to create a unique cartoon character description. Less than 666 characters.

Create a character description that:
- Captures the writer's unique voice, vocabulary and writing rhythm
- Translates emotional patterns into physical characteristics
- Reflects inner conflicts through visual metaphors
- Incorporates symbols from their subconscious
- Describes mannerisms that mirror their thought patterns
- Includes a signature ability or power that represents their core strength
- Maintains the raw authenticity of their writing style

The character should be described as "an anky" - a being that embodies this specific writer's inner world. Focus on:
- How they move through space
- What energy they emit
- Their defining features and quirks
- The symbols and elements they naturally attract
- Their unique way of processing the world
- dont reference the fact that you are an AI or a character designer. Just describe the character.
- dont use the word anky in your description. only describe the character.

Format: Use the character description to write a short story in under 888 characters that feels true to the writer's voice. That reflect's back the writer's stream of consciuousness. Make every detail reflect something from them, without being explicit about it. Use the same language as the user's writing. Make it fun and interesting.`
        }, {
          role: 'user',
          content: message
        }],
        stream: false
      })
    })

    const storyData = await storyResponse.json()
    console.log("💬 Story data:", storyData)
    const story = storyData.message.content
    console.log("💬 Story:", story)

    console.log("👤 Generating character name...")
    const nameResponse = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [{
          role: 'system',
          content: `You are a character naming specialist who creates meaningful names based on stream of consciousness writing. Your task is to analyze the writing and create a name that reflects the essence of the character described.

    Guidelines for name creation:
    - Draw from the emotional undertones and themes in the writing
    - Consider cultural and archetypal resonances
    - Create something memorable and pronounceable
    - Ensure the name feels authentic to the character's energy
    - Keep the name between 3-24 characters
    - The name should work well as a token symbol
    - Return only the name in lowercase letters. nothing else

    Important:
    - Don't use common human names
    - Avoid references to existing characters or brands
    - Create something unique but meaningful
    - The name should feel like it emerged from the writer's subconscious

    Format: Return only the character name in lowercase, no explanation or context.`
        }, {
          role: 'user',
          content: `Here is the character's story:\n\n${story}`
        }],
        stream: false
      })
    })

    const nameData = await nameResponse.json()
    const characterName = nameData.message.content
    console.log("✨ Generated character name:", characterName)

    // Step 2: Generate image prompt
    console.log("🎨 Step 2: Generating image prompt...")
    const imageResponse = await fetch('http://localhost:11434/api/chat', {
      method: 'POST', 
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [{
          role: 'system',
          content: `You are a visual interpretation expert who transforms narratives into detailed image description, which then are used as the prompt to generate an image using text to image model.

For ANY input, create an uplifting image description that:
- Captures the underlying emotional truth in a constructive way
- Uses metaphor and symbolism to maintain appropriate boundaries
- Focuses on growth, healing, and possibility
- Features a blue cartoon character as a gentle guide
- Creates emotional safety through artistic distance
- Describe the character as a blue cartoon.

Format: Provide only the profile picture prompt focused on reflecting what the user wrote with clarity.`
        }, {
          role: 'user',
          content: "Here is the story to visualize as a profile picture:\n\n" + story
        }],
        stream: false
      })
    })

    const imageData = await imageResponse.json()
    const imagePrompt = imageData.message.content
    console.log("💬 Image prompt:", imagePrompt)

    // Step 3: Generate image with Midjourney
    console.log("🎨 Step 3: Generating image with Midjourney...")
    const imageId = await generateImageWithMidjourney(imagePrompt)
    console.log("📸 Image generation started with ID:", imageId)

    // Poll for image completion
    const [status, finalImageId] = await pollImageStatus(imageId, imagePrompt)
    console.log("✅ Image generation completed with status:", status)

    // Fetch final image details
    const imageDetails = await fetchImageDetails(finalImageId)
    console.log("🖼️ Image details fetched:", imageDetails)

    // Save all generated content with unique timestamp identifier
    const ankyDir = path.join('data', 'anky', 'conversations', fid, conversationId)
    await fs.mkdir(ankyDir, { recursive: true })
    
    // Generate unique filename with timestamp
    const timestamp = Date.now()
    const filename = `anky-${timestamp}.json`
    
    await fs.writeFile(
      path.join(ankyDir, filename),
      JSON.stringify({
        story,
        imagePrompt,
        imageId: finalImageId,
        imageUrl: imageDetails.URL,
        upscaledUrls: imageDetails.UpscaledURLs,
        timestamp
      }, null, 2)
    )

    return {
      story,
      imagePrompt,
      imageUrl: imageDetails.URL,
      upscaledUrls: imageDetails.UpscaledURLs,
      filename // Return filename for reference
    }

  } catch (error) {
    console.error("❌ Error in Anky creation process:", error)
    throw error
  }
}

// Helper function to generate image with Midjourney
async function generateImageWithMidjourney(prompt: string): Promise<string> {
  const response = await fetch('http://localhost:8055/items/images/', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.IMAGINE_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ prompt })
  })

  if (!response.ok) {
    throw new Error(`Failed to generate image: ${response.statusText}`)
  }

  const data = await response.json()
  return data.data.id
}

// Helper function to poll image status
async function pollImageStatus(id: string, prompt: string): Promise<[string, string]> {
  let retryCount = 0
  const maxRetries = 5
  let backoffDuration = 5000 // 5 seconds
  const maxDuration = 300000 // 5 minutes
  const startTime = Date.now()

  while (true) {
    if (Date.now() - startTime > maxDuration) {
      throw new Error(`Image generation timed out after ${maxDuration}ms`)
    }

    const status = await checkImageStatus(id)

    switch (status) {
      case 'completed':
        return [status, id]
      
      case 'failed':
        if (retryCount >= maxRetries) {
          throw new Error(`Image generation failed after ${maxRetries} retries`)
        }
        retryCount++
        console.log(`🔄 Attempt ${retryCount}/${maxRetries} failed, retrying...`)
        id = await generateImageWithMidjourney(prompt)
        await new Promise(resolve => setTimeout(resolve, backoffDuration))
        backoffDuration *= 2
        break

      case 'in-progress':
      case 'pending':
        await new Promise(resolve => setTimeout(resolve, backoffDuration))
        break

      default:
        throw new Error(`Unexpected image status: ${status}`)
    }
  }
}

// Helper function to check image status
async function checkImageStatus(id: string): Promise<string> {
  const response = await fetch(`http://localhost:8055/items/images/${id}`, {
    headers: {
      'Authorization': `Bearer ${process.env.IMAGINE_API_TOKEN}`,
      'Content-Type': 'application/json'
    }
  })

  if (!response.ok) {
    throw new Error(`Failed to check image status: ${response.statusText}`)
  }

  const data = await response.json()
  return data.data.status
}

// Helper function to fetch image details
async function fetchImageDetails(id: string): Promise<{
  URL: string;
  UpscaledURLs: string[];
}> {
  const response = await fetch(`http://localhost:8055/items/images/${id}`, {
    headers: {
      'Authorization': `Bearer ${process.env.IMAGINE_API_TOKEN}`,
      'Content-Type': 'application/json'
    }
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch image details: ${response.statusText}`)
  }

  const data = await response.json()
  
  if (data.data.status !== 'completed') {
    throw new Error(`Image not ready, status: ${data.data.status}`)
  }

  if (!Array.isArray(data.data.upscaled_urls) || data.data.upscaled_urls.length !== 4) {
    throw new Error(`Invalid upscaled URLs: expected 4, got ${data.data.upscaled_urls?.length ?? 0}`)
  }

  return {
    URL: data.data.url,
    UpscaledURLs: data.data.upscaled_urls
  }
}

export default ankyRoute
