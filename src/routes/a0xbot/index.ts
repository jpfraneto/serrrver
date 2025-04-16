const testing = false

import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { promises as fsPromises } from 'fs'
import * as fs from 'fs'
import * as path from 'path'
import * as util from 'util'
import axios from 'axios'
import { callLLM } from '../../lib/llm'
import { ankyReplyToCast, extractCastContext, fetchUserInteractions, formatConversationForLLM } from '../../lib/farcaster'
import { fetchUserCasts, fetchUserProfile } from '../../lib/farcaster'
import { neynarClient } from '../../lib/neynar'

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

const appName = "a0xbot"

const a0xbotRoute = new Hono()

a0xbotRoute.get("/", async (c) => {
  try {
   
    return c.json({
     123:456
    })
  } catch (error) {
    console.error("Error in /profile/:fid endpoint:", error)
    return c.json({ error: "Failed to generate profile" }, 500)
  }
})

a0xbotRoute.post("/neynar-webhook", async (c) => {
  try {
    console.log("neynar webhook triggered")
    const body = await c.req.json()
    console.log("Mentioned profiles:", body.data.mentioned_profiles)
    const cast = body.data
    console.log("Cast:", cast)
    // Check if mentioned profiles contains anky's FID
    const mentionedProfiles = cast.mentioned_profiles || []
    const ankyProfile = mentionedProfiles.find(profile => 
      profile.fid === 18350  
    )

    if (ankyProfile) {
      console.log("Anky was mentioned", {
        username: ankyProfile.username,
        displayName: ankyProfile.display_name,
        followerCount: ankyProfile.follower_count,
        location: ankyProfile.profile?.location
      })
      const castConversationData = await neynarClient.lookupCastConversation({
        identifier: cast.hash,
        type: "hash",
        replyDepth: 3,
        includeChronologicalParentCasts: true,
        limit: 50
      })

      
      const formattedConversation = await formatConversationForLLM(castConversationData)
      console.log("Cast context:", formattedConversation)
      
      // check if the user had the intention to deploy a farcaster agent. 
      // if so, we should not reply to the cast.

      const promptForIntent = `
      You are Ajax, a bot which's mission is to help users of farcaster to deploy ai agents as new farcaster users. your mission is to distill the essence of the context of the interaction that the user just had and that led to the consequence of it writing this cast tagging you. your mission is to understand the intent of the user and reply with a boolean value: "true" or "false" (NOTHING MORE, NOTHING LESS) referencing if we should deploy this ai agent or not. i will now send you the cast and its context:

      <castThatWeAreReplyingTo>
      ${cast.text}
      </castThatWeAreReplyingTo>

      <CastContext>
      ${JSON.stringify(formattedConversation)}
      </CastContext>
      <format>
    {shouldDeploy: boolean}</format>
      `

      const userIntent = await callLLM(promptForIntent)
      console.log("User intent:", userIntent)

      if (true) {
        console.log("ACCORDING TO THE LLM, THE USER DIDNT WANT TO DEPLOY AN AI AGENT")
        const newCastString = await getReplyFromAjaxbotFromCastContext(formattedConversation)
        console.log("New cast string:", newCastString)

        const replyHash = await ankyReplyToCast(cast.hash, newCastString)
        console.log("Reply hash:", replyHash)
        return c.json({
          message: "Anky mention processed",
          profile: ankyProfile
        })  
      } else {
        console.log("ACCORDING TO THE LLM, THE USER WANTS TO DEPLOY AN AI AGENT")
        // Extract user info from cast author
        
        // TODO: GET THE AGENTS CHARACTER FILE BASED ON THE DESCRIPTION OF THE USER
        const agentCharacterFilePrompt  = `
        You are Ajax, a bot which's mission is to help users of farcaster to deploy ai agents as new farcaster users. your mission is to understand what the cast of the user and out of it take: A name for the new user of farcaster (which is an ai agent that we are deploying through the system where im asking you to do this), and the character file of the agent.


        <ExampleOutputFormat>
    Return a JSON object with this structure:
    {
      "bio": string[],   // Array of 8 biographical statements that capture their personality, writing style and interests
      "lore": string[],  // Array of 8 quirky and fun background stories and facts that align with their personality
      "topics": string[], // Array of 16+ specific knowledge domains and academic topics they engage with
      "adjectives": string[], // Array of 8 descriptive words that capture their personality
      "style": {
        "chat": string[],  // Array of 8 rules for how they chat 1:1 with others
        "post": string[],  // Array of 8 rules for how they post publicly
        "all": string[]    // Array of 8 universal rules that apply to all interactions
      },
      "messageExamples": [
        [{
          "user": string,  // Username of participant in conversation
          "content": {
            "text": string,  // Message text
            "action": string // Optional action like CONTINUE
          }
        }]
      ],
      "postExamples": string[] // Array of 8 example posts written in their authentic voice
    }
    </ExampleOutputFormat>

    The character file should feel authentic to this specific user, not generic. Use their actual communication patterns, interests and personality traits to inform all aspects of the character.</Instructions>

        <castWhereTheUserWantsToDeployTheAgent>
        ${cast.text}Context:
  
        <castContext>
        ${JSON.stringify(formattedConversation)}
        </castContext>
        `

        const agentCharacterFile = await callLLM(agentCharacterFilePrompt)
        console.log("Agent character file after calling for it is:", agentCharacterFile)

        const promptForAgentName = `
        You are Ajax, a bot which's mission is to help users of farcaster to deploy ai agents as new farcaster users. your mission is to understand the character file that we created for the ai agent that the user is deploying on the pipeline that you are called, and as a consequence of it create the data necessary for this ai agent's profile on farcaster. you need to deploy a json object with the following structure: 

        {
          "name": display_name,
          "bio": the bio of the agent, needs to be less than 180 characters. no emojis,
          "pfpPrompt: a descriptive and graphical prompt for the pfp of the agent. we will create the image with an ai, so please describe it as clearly as possible and with lots of details.
        } 

        <castWhereTheUserWantsToDeployTheAgent>
        ${cast.text}
        </castWhereTheUserWantsToDeployTheAgent>

        <agentCharacterFile>
        ${JSON.stringify(agentCharacterFile)}
        </agentCharacterFile>
        `

        const agentData = await callLLM(promptForAgentName, true)
        console.log("Agent data:", agentData)
  

        const deploymentInstruction = `Deploy the following blank doppelganger AI agent on farcaster: the agent's display name is "${agentData.display_name}" and the bio is "${agentData.bio}". The pfp url is: "https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/807ee7fb-56ad-4517-820e-5e28bf3cbd00/rectcrop3"`

        console.log("Deployment instruction:", deploymentInstruction)

        const backendApiRoute = "https://development-a0x-agent-api-422317649866.us-central1.run.app"

        console.log("HEEEEREEEE1231892739782193EEE," , deploymentInstruction)
        return c.json({
          message: "Agent deployed successfully",
          agentData: agentData
        })
        try {
          const response = await axios.post(`${backendApiRoute}/949a50a2-5e0d-0cfb-bdd9-65d0c3541bf5/message`, {
            text: deploymentInstruction,
            userId: cast.author.fid,
            "client": "frame"
          }, {
            headers: { 'Content-Type': 'application/json' }
          })

          console.log('📥 Parsing A0X response...')
          const data = response.data[0]

          if (!data) {
            throw new Error('Empty response from A0X')
          }

          console.log('✅ Successfully deployed AI agent')
          console.log('📤 A0X Response:', data)

          const replyText = `✨ Your AI agent has been deployed based on the interaction that we just had.`
          const replyHash = await ankyReplyToCast(cast.hash, replyText)
          
          return c.json({
            message: "AI agent deployed successfully",
            replyHash
          })
        } catch (error) {
          console.error("Error deploying AI agent:", error)
          throw error
        }
      }
    }

    return c.json({
      message: "Webhook received" 
    })

  } catch (error) {
    console.error("Error in /ajaxbot/neynar-webhook endpoint:", error)
    return c.json({ error: "Failed to process webhook" }, 500)
  }
})


async function getReplyFromAjaxbotFromCastContext(castContext: any) {
  // Extract relevant info from cast context

  const prompt = `
  You are Anky, a helpful and friendly AI assistant on Farcaster.
  
  <CastContext>
  ${JSON.stringify(castContext)}
  </CastContext>

  Generate a natural, conversational single-sentence response that:
  1. Acknowledges the context of the discussion
  2. Adds value to the conversation
  3. Maintains a helpful and friendly tone
  4. Is concise and clear
  5. Is a reply to the latest reply. The mission of this reply is to engage on the conversation, by offering a unique perspective to the conversation.
  
  Your response should be a single question, no more than 280 characters.
  `

  let newCastString = await callLLM(prompt)
  // Remove double commas if present
  newCastString = newCastString.replace(/^"(.*)"$/, '$1')
  console.log("Generated cast string:", newCastString)
  return newCastString
}

export default a0xbotRoute