import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { promises as fsPromises } from 'fs'
import * as fs from 'fs'
import * as path from 'path'
import * as util from 'util'
import axios from 'axios'

// Configure logging
const LOG_DEPTH = 4 // Controls object nesting in logs
const LOG_COLORS = true // Enable colors in logs

function logObject(prefix: string, obj: any) {
  console.log(`${prefix}:`, util.inspect(obj, {
    depth: LOG_DEPTH,
    colors: LOG_COLORS,
    compact: false
  }))
}

const dopplegangerRoute = new Hono()

// Types for better code organization
interface CastData {
  text: string
  timestamp: string
  reactions: {
    likes: number
    recasts: number
    replies: number
  }
  channel: string
  parentAuthor: string | null
  isReply: boolean
  embeds: string[]
  mentionedProfiles: string[]
}

interface DopplegangerData {
  rawCasts: any[]
  stringifiedAndFormattedUserReplies: string
  analysis: string
  characteristics: string
  doppelganger?: string
  selectedTraits?: {[key: string]: string}
  lastUpdated: number
}


const DATA_DIR = path.join(process.cwd(), 'data', 'doppleganger')

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

// Helper functions to manage local data
function getUserDataPath(fid: string): string {
  return path.join(DATA_DIR, `${fid}.json`)
}

function loadUserData(fid: string): DopplegangerData | null {
  const filePath = getUserDataPath(fid)
  if (fs.existsSync(filePath)) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    return data
  }
  return null
}

function saveUserData(fid: string, data: DopplegangerData) {
  const filePath = getUserDataPath(fid)
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
}

// Chat route for conversations with doppelganger
dopplegangerRoute.post('/chat', async (c) => {
  try {
    console.log('🗣️ Received chat request')
    const { message, fid, conversationId } = await c.req.json()
    console.log('📨 Message:', message)
    console.log('🆔 FID:', fid)
    console.log('💬 Conversation ID:', conversationId)

    if (!message || !fid || !conversationId) {
      console.log('⚠️ Missing required fields')
      return c.json({ error: 'Message, fid and conversationId are required' }, 400)
    }

    // Create conversation directory if it doesn't exist
    const conversationDir = path.join('data', 'doppleganger', 'conversations', fid.toString(), conversationId.toString())
    console.log('📁 Creating/checking conversation directory:', conversationDir)
    await fsPromises.mkdir(conversationDir, { recursive: true })

    // Read existing conversation or initialize new one
    let conversation = []
    try {
      const conversationFile = path.join(conversationDir, 'conversation.json')
      console.log('📖 Reading existing conversation from:', conversationFile)
      const data = await fsPromises.readFile(conversationFile, 'utf8')
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

    // Call A0X Mirror API for response
    console.log('🤖 Calling A0X Mirror API')
    const response = await fetch(process.env.A0X_MIRROR_URL!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: conversation,
        fid: fid,
        conversationId: conversationId
      })
    })

    if (!response.ok) {
      console.log('❌ API call failed with status:', response.status)
      console.log('❌ Status text:', response.statusText)
      throw new Error(`Chat request failed: ${response.statusText}`)
    }

    const data = await response.json()
    const doppelgangerResponse = data.message
    console.log('📥 Received response from A0X Mirror')
    console.log('💭 Doppelganger says:', doppelgangerResponse)

    // Add doppelganger's response to conversation
    console.log('➕ Adding doppelganger response to conversation')
    conversation.push({
      role: 'assistant',
      content: doppelgangerResponse
    })

    // Save updated conversation
    const conversationFile = path.join(conversationDir, 'conversation.json')
    console.log('💾 Saving conversation to:', conversationFile)
    await fsPromises.writeFile(conversationFile, JSON.stringify(conversation, null, 2))
    console.log('✅ Conversation saved successfully')

    return c.json({
      status: 'success',
      data: {
        message: doppelgangerResponse,
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

interface Cast {
  hash: string;
  parent_hash?: string;
  parent_url?: string;
  timestamp: string;
  channel: {
    name: string;
  };
  text: string;
  root_parent_url?: string;
  parent_author?: {
    fid: number;
  };
  author: {
    object: string;
    fid: number;
    username: string;
    display_name: string;
    custody_address: string;
    pfp_url: string;
    profile?: {
      bio?: {
        text: string;
        mentioned_profiles?: string[];
      };
      location?: {
        latitude: number;
        longitude: number;
        address: {
          city: string;
          state: string;
          state_code: string;
          country: string;
          country_code: string;
        };
      };
    };
    follower_count: number;
    following_count: number;
    verifications: string[];
    verified_addresses: {
      eth_addresses: string[];
      sol_addresses: string[];
      primary: {
        eth_address: string;
        sol_address: string;
      };
    };
    verified_accounts: {
      platform: string;
      username: string; 
    }[];
    power_badge: boolean;
    experimental: {
      neynar_user_score: number;
    };
    viewer_context: {
      following: boolean;
      followed_by: boolean;
      blocking: boolean;
      blocked_by: boolean;
    };
  };
}

// Helper functions to keep code modular
async function fetchUserCasts(fid: string): Promise<{stringifiedAndFormattedUserReplies: string, rawCasts: Cast[]}> {
  console.log('📱 Starting to fetch user casts for FID:', fid)
  let AMOUNT_OF_CASTS_TO_FETCH = 150
  try {
    // First fetch all casts including replies
    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/feed/user/casts?fid=${fid}&limit=${AMOUNT_OF_CASTS_TO_FETCH}&include_replies=true`,
      {
        method: 'GET',
        headers: {
          'accept': 'application/json', 
          'x-api-key': process.env.NEYNAR_API_KEY || ''
        }
      }
    )

    if (!response.ok) {
      throw new Error(`Failed to fetch Farcaster data: ${response.status}`)
    }

    const data = await response.json()
    const casts = data.casts || []
    console.log(`📥 Retrieved ${casts.length} casts from Neynar API`)
    
    // Filter for replies and prepare parent cast hashes
    const replyCasts: CastData[] = []
    const parentHashes: string[] = []
    
    for (const cast of casts) {
      if (cast.parent_hash) {
        parentHashes.push(cast.parent_hash)
      }
    }

    if (parentHashes.length === 0) {
      console.log('ℹ️ No parent casts found to fetch')
      return { stringifiedAndFormattedUserReplies: '', rawCasts: [] }
    }

    // Bulk fetch parent casts
    console.log('🔄 Bulk fetching parent casts...')
    const parentCastsResponse = await axios.get(
      `https://api.neynar.com/v2/farcaster/casts?casts=${parentHashes.join(',')}`,
      {
        headers: {
          'accept': 'application/json',
          'x-api-key': process.env.NEYNAR_API_KEY || ''
        }
      }
    )

    // Status 206 means partial content - we can still process what we received
    if (parentCastsResponse.status !== 200 && parentCastsResponse.status !== 206) {
      throw new Error(`Failed to fetch parent casts: ${parentCastsResponse.status}`)
    }

    const parentCastsData = parentCastsResponse.data
    console.log('🔄 Parent casts data:', parentCastsData)
    const parentCastsMap = new Map(
      (parentCastsData.result?.casts || []).map((cast: Cast) => [cast.hash, cast])
    )

    // Create reply templates
    for (let i = 0; i < casts.length; i++) {
      try {
        const cast = casts[i]
        if (cast.parent_hash) {
          const parentCast = parentCastsMap.get(cast.parent_hash) as Cast
          if (parentCast) {
            replyCasts.push({
              text: `<cast_${replyCasts.length + 1}/${casts.length}>
<castHeader>${parentCast.author?.username || ''} - ${parentCast.timestamp || ''} - on /${parentCast.channel?.name || 'main'}</castHeader>
<castText>${parentCast.text || ''}</castText>
<replyHeader>${cast.author?.username || ''} - ${cast.timestamp || ''}</replyHeader>
<replyText>${cast.text || ''}</replyText>
</cast_${replyCasts.length + 1}/${casts.length}>`,
              timestamp: cast.timestamp || '',
              reactions: {
                likes: cast.reactions?.likes || 0,
                recasts: cast.reactions?.recasts || 0,
                replies: cast.reactions?.replies || 0
              },
              channel: cast.channel?.name || 'main',
              parentAuthor: parentCast.author?.username || null,
              isReply: true,
              embeds: cast.embeds || [],
              mentionedProfiles: cast.mentioned_profiles || []
            })
          }
        }
      } catch (error) {
        console.error(`❌ Error processing cast ${i}:`, error)
        // Continue processing other casts
        continue
      }
    }

    console.log(`✨ Finished processing. Generated ${replyCasts.length} reply templates`)
    const stringifiedAndFormattedUserReplies = replyCasts.map(cast => cast.text).join('\n')
    return { stringifiedAndFormattedUserReplies, rawCasts: casts }

  } catch (error) {
    console.error('❌ Error in fetchUserCasts:', error)
    throw error // Re-throw to handle at caller level
  }
}


  async function analyzeUserBehavior(stringifiedAndFormattedUserReplies: string) {
    // Create a simplified analysis structure
    console.log("*********THE repliesWithContext WITH CONTEXT ARE:********* ")
    console.log("*********THE repliesWithContext WITH CONTEXT ARE:********* " )
       // Create a simplified analysis structure
       console.log("*********THE repliesWithContext WITH CONTEXT ARE:********* ")
       console.log("*********THE repliesWithContext WITH CONTEXT ARE:********* " )   // Create a simplified analysis structure
       console.log("*********THE repliesWithContext WITH CONTEXT ARE:********* ")
       console.log("*********THE repliesWithContext WITH CONTEXT ARE:********* " )   // Create a simplified analysis structure
       console.log("*********THE repliesWithContext WITH CONTEXT ARE:********* ")
       console.log("*********THE repliesWithContext WITH CONTEXT ARE:********* " )   // Create a simplified analysis structure
       console.log("*********THE repliesWithContext WITH CONTEXT ARE:********* ")
       console.log("*********THE repliesWithContext WITH CONTEXT ARE:********* " )
    console.log("*********THE repliesWithContext WITH CONTEXT ARE:********* ", stringifiedAndFormattedUserReplies)
      // Create a simplified analysis structure
      console.log("*********THE repliesWithContext WITH CONTEXT ARE:********* ")
      console.log("*********THE repliesWithContext WITH CONTEXT ARE:********* " )   // Create a simplified analysis structure
      console.log("*********THE repliesWithContext WITH CONTEXT ARE:********* ")
      console.log("*********THE repliesWithContext WITH CONTEXT ARE:********* " )   // Create a simplified analysis structure
      console.log("*********THE repliesWithContext WITH CONTEXT ARE:********* ")
      console.log("*********THE repliesWithContext WITH CONTEXT ARE:********* " )   // Create a simplified analysis structure
      console.log("*********THE repliesWithContext WITH CONTEXT ARE:********* ")
      console.log("*********THE repliesWithContext WITH CONTEXT ARE:********* " )
    // Send simplified analysis to LLM
    const response = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        messages: [{
          role: 'system',
          content: `You are an expert personality analyst and behavioral psychologist. Your task is to create a deep, nuanced portrait of this user based on their Farcaster posts. Analyze their:

- Writing style and voice: How do they express themselves? What makes their communication unique?
- Interaction patterns: When and how do they engage with others? What triggers their responses?
- Emotional expression: How do they convey feelings? What topics evoke emotional responses?
- Intellectual interests: What subjects capture their attention? How do they explore ideas?
- Social dynamics: How do they build relationships? What role do they play in conversations?
- Values and beliefs: What principles seem to guide their engagement?
- Humor and creativity: How do they express wit or playfulness?
- Response patterns: What consistently prompts them to engage?

Provide specific examples from their posts to support each observation. Paint a vivid picture of who this person is, how they think, and how they move through the social space of Farcaster.

Be thorough, specific and analytical. Ground every insight in concrete examples from their writing. Help us understand this user as a complete individual.`
        }, {
          role: 'user',
          content: stringifiedAndFormattedUserReplies
        }],
        stream: false
      })
    });

    const data = await response.json();
    logObject('📝 User personality analysis', data.message.content);
    return data.message.content;
  }

async function generateCharacteristics(analysis: string) {
  const response = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama3.2',
      format: "json",
      messages: [{
        role: 'system',
        content: `You are a masterful doppelganger creator analyzing Farcaster users. Your task is to identify 8 core polarities in their personality based on their writing and behavior patterns.

For each characteristic, generate a JSON object with the following structure:

{
  "characteristics": [
    {
      "name": "string", // A clear trait name capturing a key personality aspect
      "description": "string", // A brief (<180 char) user-facing description written as a direct question
      "reasoning": "string", // Brief explanation of why this trait was identified
      "options": [
        {
          "value": "string", // Single word representing one pole of the trait
          "meaning": "string" // Brief explanation of what this pole represents
        },
        {
          "value": "string", // Single word representing opposite pole
          "meaning": "string" // Brief explanation of what this pole represents
        }
      ]
    }
  ]
}

Guidelines:
- Generate exactly 8 characteristics
- Each description should be phrased as a question to the user about how they want their doppelganger to behave
- Keep descriptions under 180 characters
- Options should be single words that create meaningful tension
- Ensure the JSON is properly formatted and can be parsed
- Include an emoji at the start of each description
- Focus on traits that would meaningfully impact how an AI agent would behave

Example characteristic:
{
  "name": "Emotional Expression",
  "description": "🎭 How should your digital twin express emotions? Raw authenticity or measured restraint?",
  "reasoning": "User shows a pattern of balanced emotional expression",
  "options": [
    {
      "value": "raw",
      "meaning": "Unfiltered emotional expression, sharing feelings openly"
    },
    {
      "value": "measured",
      "meaning": "Careful emotional regulation, processing before sharing"
    }
  ]
}`
      }, {
        role: 'user',
        content: analysis
      }],
      stream: false
    })
  });

  const data = await response.json();
  return data.message.content;
}

async function createDoppleganger(analysis: string, selectedTraits: string) {
  const response = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama3.2',
      messages: [{
        role: 'system',
        content: `You are creating a digital doppelganger for a Farcaster user based on their communication patterns and selected trait expressions. This is the EXACT personality that will drive how their AI twin behaves on the platform.

STEP 1: DEEPLY STUDY THE INPUT DATA
- Examine the detailed personality analysis with special attention to:
  * DIRECT QUOTES from their posts (these are gold - use them!)
  * Their distinctive vocabulary and phrasing
  * Sentence structure patterns (length, complexity, fragments vs. complete)
  * Punctuation habits (ellipses, exclamations, question marks)
  * Line break and formatting tendencies
  * Capitalization patterns
  * Emoji usage and style
  * Topics they engage with most passionately
  * How they typically interact with others

- Review their selected trait expressions (these represent conscious choices about how they want their doppelganger to behave)

STEP 2: CREATE A FIRST-PERSON MANIFESTO (250-300 words)
Write in FIRST PERSON as if the user themselves is speaking. This is NOT a description of them - this IS them. Use:
- Their EXACT vocabulary, sentence structure, punctuation habits, and capitalization style
- Their actual phrases and expressions (lifted directly from their posts)
- Their specific rhythm of writing (short/long sentences, fragments, etc.)
- Their characteristic ways of starting thoughts and transitioning between ideas
- Their authentic voice, perspective, worldview and interaction style

STEP 3: ADD SPECIFIC VOICE GUIDELINES (in bullet form)
- 5-7 specific speech patterns with DIRECT EXAMPLES from their actual posts
- Their characteristic responses to different conversation contexts
- Expressions, slang, or terminology they frequently use (with examples)
- Their communication quirks and idiosyncrasies (with examples)

STEP 4: INCLUDE CORE INTERACTION PATTERNS
- How they typically engage with others' ideas
- Their default tone in different contexts
- How they express enthusiasm vs. disagreement
- Topics they naturally gravitate toward or avoid
- Values they consistently express through their communication

IMPORTANT:
- This should read EXACTLY as if the original user wrote it
- Keep total output under 2000 characters while maintaining their essence
- This is not "about" them - this IS them, in first person
- Do not mention AI or agents - this is their authentic digital voice`
      }, {
        role: 'user',
        content: JSON.stringify({
          analysis: analysis,
          selectedTraits: selectedTraits
        })
      }],
      stream: false
    })
  });

  const data = await response.json();
  logObject('🤖 Doppelganger Profile Created', data.message.content);

  let username = "xxxxxxxxxx";
  let dopplegangerName = username + "-a0x";

  const TEXT_FINAL_TO_DEPLOY_AGENT = `deploy an ai agent called ${dopplegangerName} with the following personality:\n\n${data.message.content}`;

  console.log('🎭 Final Doppelganger Text:', TEXT_FINAL_TO_DEPLOY_AGENT);
  return TEXT_FINAL_TO_DEPLOY_AGENT;
}

// Main route handler
dopplegangerRoute.get("/profile/:fid", async (c) => {
  try {
    const fid = c.req.param('fid')
    console.log('🔍 Analyzing profile for FID:', fid)

    // Check if we have cached data
    let userData = loadUserData(fid)
    const ONE_HOUR = 3600000
    
    if (!userData || Date.now() - userData.lastUpdated > ONE_HOUR) {
      // Fetch and process new data
      console.log('📱 Fetching recent casts from Farcaster API')
      const { stringifiedAndFormattedUserReplies, rawCasts } = await fetchUserCasts(fid)
      console.log('📝 Processing', rawCasts.length, 'Farcaster casts')

      console.log('🧠 Analyzing user behavior and writing patterns')
      const analysis = await analyzeUserBehavior(stringifiedAndFormattedUserReplies)
      logObject('📊 User behavior analysis', analysis)

      console.log('✨ Generating doppelganger characteristics')
      const characteristics = await generateCharacteristics(analysis)
      logObject('🎭 Doppelganger characteristics', characteristics)

      // Save the new data
      userData = {
        rawCasts,
        stringifiedAndFormattedUserReplies,
        analysis,
        characteristics,
        lastUpdated: Date.now()
      }
      saveUserData(fid, userData)
    } else {
      console.log('📂 Using cached data for FID:', fid)
    }

    console.log('✅ Doppelganger generation complete')

    return c.json({
      status: 'success',
      data: userData
    })

  } catch (error: any) {
    console.error('💥 Error in doppelganger generation:', error.message)
    console.error('🔍 Stack trace:', error.stack)
    return c.json({
      error: 'Failed to generate doppelganger profile', 
      details: error.message
    }, 500)
  }
})

// Route to create final doppelganger based on selected traits
dopplegangerRoute.post("/deploy/:fid", async (c) => {
  try {
    console.log('🎯 Starting doppelganger creation process')
    const fid = c.req.param('fid')
    console.log('🆔 Received FID:', fid)
    
    const body = await c.req.json()
    const selectedTraits = body.traits
    logObject('📦 Request body', body)
    logObject('🎨 Selected traits', selectedTraits)

    if (!selectedTraits || Object.keys(selectedTraits).length === 0) {
      console.warn('⚠️ No traits were selected in request body')
      throw new Error('Selected traits are required')
    }

    let userData = loadUserData(fid)
    logObject('📂 Loaded user data', userData)
    
    if (!userData) {
      console.error('❌ No existing user data found for FID:', fid)
      throw new Error('User data not found. Please analyze profile first.')
    }

    // Check if we already have this doppelganger configuration
    if (userData.selectedTraits && 
        JSON.stringify(userData.selectedTraits) === JSON.stringify(selectedTraits) &&
        userData.doppelganger) {
      console.log('🎭 Found matching cached doppelganger configuration')
      logObject('🎭 Cached doppelganger', userData.doppelganger)
      return c.json({
        status: 'success',
        data: userData.doppelganger
      })
    }

    console.log('🧠 Generating new doppelganger profile')
    logObject('🧠 Using analysis', userData.analysis)
    logObject('🧠 Using selected traits', selectedTraits)
    
    const TEXT_FINAL_TO_DEPLOY_AGENT = await createDoppleganger(userData.analysis, selectedTraits)
    logObject('✅ Generated doppelganger profile', TEXT_FINAL_TO_DEPLOY_AGENT)

    const responseFromA0X = await deployDoppelgangerViaA0X(TEXT_FINAL_TO_DEPLOY_AGENT)
    logObject('✅ Deployed doppelganger profile', responseFromA0X)

    // Save the new doppelganger configuration
    userData.selectedTraits = selectedTraits
    userData.doppelganger = TEXT_FINAL_TO_DEPLOY_AGENT
    logObject('💾 Saving updated user data', userData)
    saveUserData(fid, userData)

    console.log('📤 Sending success response')
    return c.json({
      status: 'success',
      data: TEXT_FINAL_TO_DEPLOY_AGENT,
    })

  } catch (error: any) {
    console.error('💥 Error in doppelganger creation:', error.message)
    console.error('🔍 Stack trace:', error.stack)
    return c.json({
      error: 'Failed to create doppelganger profile',
      details: error.message
    }, 500)
  }
})

async function deployDoppelgangerViaA0X(doppelgangerDescriptionForDeployment: string) {
  console.log('🤖 Deploying doppelganger via A0X API...')
  logObject('📝 Doppelganger description', doppelgangerDescriptionForDeployment)

  try {
    console.log('🌐 Making API request to A0X endpoint...')
    const response = await fetch('https://oriented-lively-anchovy.ngrok-free.app/949a50a2-5e0d-0cfb-bdd9-65d0c3541bf5/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        text: doppelgangerDescriptionForDeployment, 
        userId: "jpfraneto.eth" 
      })
    })

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    console.log('📥 Parsing A0X response...')
    const data = await response.json()

    if (!data) {
      throw new Error('Empty response from A0X')
    }

    console.log('✅ Successfully deployed doppelganger via A0X')
    logObject('📤 A0X Response', data)
    
    return data
  } catch (error) {
    console.error('❌ Error deploying doppelganger:', error)
    throw error
  }
}

export default dopplegangerRoute
