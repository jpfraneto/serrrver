const testing = false

import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { promises as fsPromises } from 'fs'
import * as fs from 'fs'
import * as path from 'path'
import * as util from 'util'
import axios from 'axios'
import { callLLM } from '../../lib/llm'
import { fetchUserInteractions } from '../../lib/farcaster'
import { fetchUserCasts, fetchUserProfile } from '../../lib/farcaster'

// Configure logging
const LOG_DEPTH = 4 // Controls object nesting in logs
const LOG_COLORS = true // Enable colors in logs

const backendApiRoute = "https://development-a0x-agent-api-422317649866.us-central1.run.app"


function logObject(prefix: string, obj: any) {
  console.log(`${prefix}:`, util.inspect(obj, {
    depth: LOG_DEPTH,
    colors: LOG_COLORS,
    compact: false
  }))
}

const appName = "doppelganger"

const doppelgangerRoute = new Hono()

doppelgangerRoute.get("/buy-battery/:fid", async (c) => {
  try {
    const fid = c.req.param("fid")
    const { amount, transactionHash, agentId } = await c.req.json()
    console.log("👤 FID:", fid)
    console.log("👤 Amount:", amount)
    console.log("👤 Transaction Hash:", transactionHash)
    console.log("👤 Agent ID:", agentId)

    const a0xResponse = await axios.post(`${backendApiRoute}/a0x-framework/${agentId}/update-agent-battery  `, { 
      amount,
      transactionHash,
      agentId
    }, {
      headers: { 'Content-Type': 'application/json' }
    })
     

    return c.json({
      message: "Battery bought successfully"
    })
  } catch (error) {
    console.error("Error in /buy-battery/:fid endpoint:", error)
    return c.json({ error: "Failed to buy battery" }, 500)
  }
})


doppelgangerRoute.post("/chat-with-fartwin/:id", async (c) => {
  try {
    const fartwinId = c.req.param("id")
    console.log("👤 Fartwin ID:", fartwinId)
    const {conversation, fid} = await c.req.json()
    console.log("👤 Conversation:", conversation)

    const response = await axios.post(`${backendApiRoute}/${fartwinId}/message`, { 
      text: conversation, 
      userId: fid,
      "client": "frame"
    }, {
      headers: { 'Content-Type': 'application/json' }
    })
    
    console.log('📥 Parsing A0X respons234324...')
    const data = response.data[0]

    if (!data) {
      throw new Error('Empty response from A0X')
    }

    console.log('✅ Successfully deployed doppelganger via A0X')
    logObject('📤 A0X Response HERE', data)
    return c.json({
      message: data.text
    })
  } catch (error) {
    console.error("Error in /chat-with-fartwin/:id endpoint:", error)
    return c.json({ error: "Failed to chat with fartwin" }, 500)
  }
})

doppelgangerRoute.get("/agents", async (c) => {
  try {
    const response = await axios.get(`https://development-a0x-mirror-api-422317649866.us-central1.run.app/agents?byInteractions=true&limit=8&fromDate=${Date.now()-24*60*60*1000}`)
    const agents = response.data.data
    //console.log("👤 Agents:", agents)

    return c.json({ agents: agents.filter((agent: any) => agent?.farcasterClient?.fid).slice(0,8) })
  } catch (error) {
    console.error("Error in /agents endpoint:", error)
    return c.json({ agents: [] })
  }
})

doppelgangerRoute.get("/agents/:fid", async (c) => {
  try {
    const fid = c.req.param("fid")
    console.log("👤 FID:", fid)
    const fidNumber = Number(fid);
    if (isNaN(fidNumber)) {
      return c.json({ error: "Invalid FID - must be a number" }, 400);
    }

    const A0X_MIRROR_API_URL = "https://development-a0x-mirror-api-422317649866.us-central1.run.app"
    console.log("👤 A0X mirror API URL:", A0X_MIRROR_API_URL)

    if (!process.env.A0X_MIRROR_API_KEY) {
      throw new Error("A0X_MIRROR_API_KEY environment variable is not set")
    }

    let farcasterAgents = []
    let response: { data: any } | null = null   

    try {
       response = await axios.get(
        `${A0X_MIRROR_API_URL}/agents/fid?fid=${fidNumber}`, 
        { 
          headers: {
            "x-api-key": process.env.A0X_MIRROR_API_KEY,
            "Content-Type": "application/json"
          }
        }
      );
      console.log("👤 A0X mirror response:", response?.data)
    } catch (error) {
      console.error("Error in /agents/:fid endpoint:", error)
      response = {data: []}
    }
    console.log("👤 Farcaster agents:", farcasterAgents)
  
     farcasterAgents = response?.data?.filter((agent: any) => agent.farcasterClient.status === 'approved')

    if (farcasterAgents?.length === 0) {
      // No existing agents, need to create one
      const {userDistillation, formattedUserCasts, userProfile} = await distillUserByFidDoppelganger(fidNumber, true)
      console.log("👤 User distillation:", userDistillation)
      const userPersonalityDimensions = await generatePersonalityDimensionsFromDistillationDoppelganger(fidNumber, userDistillation, formattedUserCasts, userProfile)
      console.log("👤 User personality dimensions:", userPersonalityDimensions)

      return c.json({
        agents: [],
        characteristics: userPersonalityDimensions.dimensions.map((dimension: any) => ({
          emoji: dimension.emoji,
          name: dimension.label,
          description: dimension.description,
          options: dimension.options.map((option: any) => ({
            value: option.value,
            description: option.description
          }))
        }))
      })
    }
    // Get additional info for each agent from backend API
    const agentsWithInfo = await Promise.all(farcasterAgents?.map(async (agent: any) => {
      try {
        const agentInfoResponse = await axios.get(
          `${backendApiRoute}/a0x-framework/search?agentId=${agent.agentId}`,
          {
            headers: { 'Content-Type': 'application/json' }
          }
        );
        console.log("👤 Agent info:", agentInfoResponse.data)
        return {
          ...agent,
          life: agentInfoResponse.data.life
        };
      } catch (error) {
        console.error(`Error fetching additional info for agent ${agent.agentId}:`, error);
        return agent; // Return original agent data if fetch fails
      }
    }));

    return c.json({
      agents: agentsWithInfo,
      characteristics: []
    })

  } catch (error) {
    console.error("Error in root endpoint:", error)
    if (axios.isAxiosError(error)) {
      if (error.response) {
        return c.json({ 
          error: "A0X Mirror API error",
          status: error.response.status,
          data: error.response.data
        })
      }
      return c.json({ error: "Network error connecting to A0X Mirror API" }, 503)
    }
    return c.json({ error: "Internal server error" }, 500)
  }
})

doppelgangerRoute.get("/profile/:fid", async (c) => {
  try {
    const fid = c.req.param("fid")
    console.log("👤 FID:", fid)
    const fidNumber = Number(fid);
    if (isNaN(fidNumber)) {
      return c.json({ error: "Invalid FID - must be a number" }, 400);
    }

    const userDoppelganger = await checkIfUserHasDoppelganger(Number(fid))
    if(userDoppelganger) {
      return c.json({
        fid,
        userDoppelganger,
        hasFarTwi: true
      })
    }

    const {userDistillation, formattedUserCasts, userProfile} = await distillUserByFidDoppelganger(Number(fid), true)
    console.log("👤 User distillation:", userDistillation)
    const userPersonalityDimensions = await generatePersonalityDimensionsFromDistillationDoppelganger(Number(fid),userDistillation, formattedUserCasts, userProfile)
    console.log("👤 User personality dimensions:", userPersonalityDimensions)
    return c.json({
      fid,
      characteristics: userPersonalityDimensions.dimensions.map((dimension: any) => ({
        emoji: dimension.emoji,
        name: dimension.label,
        description: dimension.description,
        options: dimension.options.map((option: any) => ({
          value: option.value,
          description: option.description
        }))
      }))
    })
  } catch (error) {
    console.error("Error in /profile/:fid endpoint:", error)
    return c.json({ error: "Failed to generate profile" }, 500)
  }
})

async function saveUserDoppelganger(fid: number, doppelganger: any) {
  const dir = './data/doppelganger/deployments';
  const filePath = `${dir}/${fid}.json`;
  fs.writeFileSync(filePath, JSON.stringify(doppelganger, null, 2));
}


async function checkIfUserHasDoppelganger(fid: number) {
  const dir = './data/doppelganger/deployments';
  const filePath = `${dir}/${fid}.json`;
  if(fs.existsSync(filePath)) {
    const data = fs.readFileSync(filePath, 'utf8');
    const deploymentInfo = JSON.parse(data);
    return deploymentInfo;
  }
  return null;
}



doppelgangerRoute.post('/deploy/:fid', async (c) => {
  try {
    const fid = c.req.param("fid")
    const {choices} = await c.req.json()
    console.log("👤 Choices:", choices)
   
    const {userDistillation , formattedUserCasts, userProfile}  = await distillUserByFidDoppelganger(Number(fid), true)
    console.log("👤 User distillation:", userDistillation)

    const personalityDimensions = await generatePersonalityDimensionsFromDistillationDoppelganger(Number(fid), userDistillation, formattedUserCasts, userProfile)
    
    const [characterJson, deploymentResult] = await Promise.all([
      constructCharacterFileForUser(personalityDimensions, userDistillation, choices, Number(fid)),
      deployDoppelgangerViaA0X(userProfile)
    ])
    
    console.log("👤 Deployment result:", deploymentResult)
    console.log("👤 Character file:", characterJson)
    if (testing) {
      return c.json({
        fid,
        deployedAgentId: deploymentResult.deployAgentId,
        clankerAddress: deploymentResult.tokenAddress,
        welcomeCastHash: deploymentResult.welcomeCastHash,
        agentName: deploymentResult.agentName,
        agentUsername: deploymentResult.agentUsername
      })
    }
    if(deploymentResult?.metadata?.errorType) {
      console.log("👤 Error in A0X response")
      return c.json({
        metadata: deploymentResult.metadata,
        text: deploymentResult.text
      })
    }

    if (deploymentResult.action == "NONE"){
      console.log("👤 No action required")
      return c.json({
        text: deploymentResult.text,
        action: "NONE"
      })
    }
    const A0X_MIRROR_API_URL = "https://development-a0x-mirror-api-422317649866.us-central1.run.app"
    console.log("👤 A0X mirror API URL:", A0X_MIRROR_API_URL)
    const response = await axios.patch(
      `${A0X_MIRROR_API_URL}/personality/${deploymentResult.agentName}`, 
       characterJson,
      { 
        headers: {
          "x-api-key": process.env.A0X_MIRROR_API_KEY!,
          "Content-Type": "application/json"
        }
      }
    );
    console.log("👤 A0X mirror response:", response)
    await saveUserDoppelganger(Number(fid), deploymentResult)
    return c.json({
      fid,
      deploymentAgentId: deploymentResult.deployAgentId,
      clankerAddress: deploymentResult.tokenAddress,
      welcomeCastHash: deploymentResult.welcomeCastHash,
      agentName: deploymentResult.agentName,
      agentUsername: deploymentResult.agentUsername
    })
  } catch (error) {
    console.error("Error in /deploy/:fid endpoint:", error)
    return c.json({ error: "Failed to deploy doppelganger" }, 500)
  }
})

async function distillUserByFidDoppelganger(fid: number, formatAsJson: boolean = false) : Promise<{userDistillation: any, formattedUserCasts: string, userProfile: any}> {
  try {
    const userCasts = await fetchUserCasts(fid)
   
    const formattedUserCasts = userCasts.map((cast: any, index: number) => {
      let castString = `<${index + 1}/${userCasts.length}>\n`;
      castString += `Cast Text: ${cast.text}\n`;
      castString += `Cast Time: ${new Date(cast.timestamp).toLocaleString()}\n`;
      
      if (cast.embeds?.length > 0) {
        castString += 'Embeds:\n';
        cast.embeds.forEach((embed: any) => {
          if (embed.url) castString += `- URL: ${embed.url}\n`;
          if (embed.metadata?.image) {
            castString += `- Image: ${embed.metadata.image.width_px}x${embed.metadata.image.height_px}\n`;
          }
          if (embed.metadata?.video) {
            castString += `- Video duration: ${embed.metadata.video.duration_s}s\n`;
          }
        });
      }

      if (cast.reactions) {
        castString += `Likes: ${cast.reactions.likes_count}\n`;
        castString += `Recasts: ${cast.reactions.recasts_count}\n`;
      }

      if (cast.replies) {
        castString += `Replies: ${cast.replies.count}\n`;
      }

      if (cast.mentioned_profiles?.length > 0) {
        castString += 'Mentions:\n';
        cast.mentioned_profiles.forEach((profile: any) => {
          castString += `- @${profile.username}\n`;
        });
      }
      castString += `</${index + 1}/${userCasts.length}>\n`;
      return castString;
    }).join('\n');
    const userProfile = userCasts[0]?.author || await fetchUserProfile(fid)
    console.log("👤 User profile:", userProfile)
    let userDistillation = await readUserDistillationformattedUserCasts(fid)
    if (userDistillation) {
      console.log(`📖 Found existing distillation for user ${fid}`);
      return {userDistillation, formattedUserCasts, userProfile};
    }

    return {userDistillation: "", formattedUserCasts, userProfile}
  } catch (error) {
    console.error("Error distilling user by fid:", error)
    throw error
  }
}

/**
 * Save a user's distillation analysis to persistent storage
 * @param fid - The Farcaster ID of the user
 * @param distillation - The distillation analysis to save
 * @returns Promise<void>
 */
async function saveUserDistillation(fid: number, distillation: string): Promise<void> {
  try {
    // Create directory if it doesn't exist
    const dir = './data/doppelganger/distillations';
    await fs.promises.mkdir(dir, { recursive: true });
    
    // Save distillation to file
    const filePath = `${dir}/${fid}.json`;
    await fs.promises.writeFile(filePath, JSON.stringify(distillation, null, 2));
    
    console.log(`✅ Saved distillation for user ${fid}`);
  } catch (error) {
    console.error(`❌ Error saving distillation for user ${fid}:`, error);
    throw error;
  }
}

/**
 * Read a user's saved distillation analysis from storage
 * @param fid - The Farcaster ID of the user
 * @returns Promise<string|null> - The distillation if found, null if not
 */
async function readUserDistillationformattedUserCasts(fid: number): Promise<string|null> {
  try {
    const filePath = `./data/doppelganger/distillations/${fid}.json`;
    
    // Check if file exists
    try {
      await fs.promises.access(filePath);
    } catch {
      return null;
    }
    
    // Read and parse distillation
    const data = await fs.promises.readFile(filePath, 'utf-8');
    const distillation = JSON.parse(data);
    
    console.log(`📖 Found existing distillation for user ${fid}`);
    return distillation;
  } catch (error) {
    console.error(`❌ Error reading distillation for user ${fid}:`, error);
    throw error;
  }
}

/**
 * Save a user's personality dimensions to persistent storage
 * @param fid - The Farcaster ID of the user
 * @param dimensions - The personality dimensions to save
 * @returns Promise<void>
 */
async function saveUserPersonalityDimensions(fid: number, dimensions: any): Promise<void> {
  try {
    // Create directory if it doesn't exist
    const dir = './data/doppelganger/personality_dimensions';
    await fs.promises.mkdir(dir, { recursive: true });
    
    // Save dimensions to file
    const filePath = `${dir}/${fid}.json`;
    await fs.promises.writeFile(filePath, JSON.stringify(dimensions, null, 2));
    
    console.log(`✅ Saved personality dimensions for user ${fid}`);
  } catch (error) {
    console.error(`❌ Error saving personality dimensions for user ${fid}:`, error);
    throw error;
  }
}

/**
 * Read a user's saved personality dimensions from storage
 * @param fid - The Farcaster ID of the user
 * @returns Promise<any|null> - The personality dimensions if found, null if not
 */
async function readUserPersonalityDimensions(fid: number): Promise<any|null> {
  try {
    const filePath = `./data/doppelganger/personality_dimensions/${fid}.json`;
    
    // Check if file exists
    try {
      await fs.promises.access(filePath);
    } catch {
      return null;
    }
    
    // Read and parse dimensions
    const data = await fs.promises.readFile(filePath, 'utf-8');
    const dimensions = JSON.parse(data);
    
    console.log(`📖 Found existing personality dimensions for user ${fid}`);
    return dimensions;
  } catch (error) {
    console.error(`❌ Error reading personality dimensions for user ${fid}:`, error);
    throw error;
  }
}


async function generatePersonalityDimensionsFromDistillationDoppelganger(fid: number, distillation: string, formattedUserCasts: string, userProfile: any) {
  try {
    if(!testing){
      const personalityDimensions = await readUserPersonalityDimensions(fid)

      if (personalityDimensions) {
        console.log(`📖 Found existing personality dimensions for user ${fid}`);
        return personalityDimensions;
      }
    }
  
    console.log("THE DISTILLATION IS: ", distillation)

    const prompt = `
  You are an expert AI personality analyst tasked with creating consistent personality dimensions for a digital clone.
  
  # TASK
  Based on the user's Farcaster content, create 8 distinct personality dimensions that accurately represent their online persona. These dimensions will be used to create a digital clone (FarTwin) of the user.

  # USER DATA
  Username: ${userProfile.username}
  Display Name: ${userProfile.display_name}
  Bio: ${userProfile.profile.bio.text}
  Followers: ${userProfile.follower_count}
  Following: ${userProfile.following_count}
  
  User's Posts:
  ${formattedUserCasts}

  # OUTPUT REQUIREMENTS - READ CAREFULLY
  You MUST create exactly 8 personality dimensions with COMPLETE information for each field:
  1. Each dimension must have an emoji, label, description, and exactly 2 options
  2. Each option must have both a "value" (one word) and a detailed "description"
  3. NO field can be empty or contain placeholder text
  4. Each dimension should focus on a distinct aspect of personality
  5. Base each dimension on clear evidence from their posts/profile
  
  # DIMENSION FORMAT INSTRUCTIONS
  For each dimension:
  - emoji: Select ONE relevant Unicode emoji character
  - label: Create a clear 2-3 word title (e.g., "Communication Style")
  - description: Write as a question: "How will your FarTwin [behavior]?"
  - options: Create TWO contrasting options with:
    - value: ONE single word
    - description: ONE sentence explaining how this choice shapes the clone's behavior
  
  # REQUIRED OUTPUT FORMAT
  Your response must be VALID JSON with this exact structure:
  {
    "dimensions": [
      {
        "emoji": "💬",
        "label": "Communication Style",
        "description": "How will your FarTwin communicate with others?",
        "options": [
          {
            "value": "Direct",
            "description": "Your FarTwin will communicate clearly and straightforwardly, stating opinions without hesitation or sugar-coating."
          },
          {
            "value": "Diplomatic",
            "description": "Your FarTwin will communicate tactfully and considerately, carefully choosing words to maintain harmony."
          }
        ]
      },
      // REPEAT ABOVE STRUCTURE FOR ALL 8 DIMENSIONS
    ]
  }

  # BEFORE SUBMITTING
  Double-check that:
  1. You have created EXACTLY 8 complete dimensions
  2. Every field has meaningful content (no empty or placeholder values)
  3. All options have both a single-word value and a descriptive sentence
  4. Your output is valid JSON that can be parsed
  5. Each dimension is based on evidence from user data
  
  # IMPORTANT
  - Return ONLY the JSON object without any additional text
  - Ensure ALL fields are properly filled
  - Do not use explanations or commentary outside the JSON structure
  - The JSON must be complete, valid, and properly formatted
  `;

    console.log("THIS SECOND PROMPT IS: ", prompt)
    const result = await callLLM(prompt, true)
    // Check if result is empty or invalid
    if (!result || !result.dimensions || result.dimensions.length === 0) {
      console.error("Error: Invalid personality dimensions result", result);
      throw new Error("Failed to generate valid personality dimensions");
    }

    console.log("👤 Generated personality dimensions:", result);
    await saveUserPersonalityDimensions(fid, result)
    return result
  } catch (error) {
    console.error("Error generating personality dimensions from distillation:", error)
    throw error
  }
}

async function constructCharacterFileForUser(personalityDimensions: any, userDistillation: string, choices: string[], fid: number) {
  try {
    // Map the user's choices to the full dimension data
    const choiceMappings = personalityDimensions.dimensions.map((dimension, index) => {
      const userChoice = choices[index];
      // Handle case where choice doesn't exactly match option value
      const selectedOption = dimension.options.find((opt: any) => 
        opt.value.toLowerCase() === userChoice?.toLowerCase()
      );
      
      if (!selectedOption) {
        console.warn(`Warning: No exact match found for dimension ${dimension.label} and choice ${userChoice}`);
        // Try to find closest matching option
        const closestOption = dimension.options[0]; // Default to first option if no match
        return {
          dimension: dimension.label,
          choice: closestOption.value,
          description: closestOption.description
        };
      }
      
      return {
        dimension: dimension.label,
        choice: userChoice,
        description: selectedOption.description
      };
    });
    console.log("THE USER DISTILLATION IS: ", userDistillation)
    const prompt = `
    Generate a character file in JSON format that captures the user's personality and communication style.

    <Context>
    Here is information about the user's communication patterns and personality:

    <UserChoices>
    ${choiceMappings.map((choice: any) => `${choice.dimension}: ${choice.choice} - ${choice.description}`).join("\n")}
    </UserChoices>


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

    The character file should feel authentic to this specific user, not generic. Use their actual communication patterns, interests and personality traits to inform all aspects of the character.</Instructions>`;

    console.log("THE PROMPT IS: ", prompt)
    
    const result = await callLLM(prompt, true);
    console.log("************************************************")
    console.log("************************************************")
    console.log("************************************************")
    console.log("************************************************")
    console.log("************************************************")
    console.log("👤 Deployment instruction ----RESULT ------:", result) 
    console.log("************************************************")
    console.log("************************************************")
    console.log("************************************************")
    console.log("************************************************")
    return result
  } catch (error) {
    console.error('Error in constructDeploymentInstruction:', error);
    throw error;
  }
}

async function deployDoppelgangerViaA0X(userProfile: {fid: string, username: string, display_name: string, profile: {bio: { text: string }}, pfpUrl: string}) {
  try {

    console.log('🌐 Making API request to A0X endpoint...', userProfile)
    const username = userProfile.username.endsWith('.eth') ? userProfile.username.slice(0, -4) : userProfile.username
    const newUsername = `${username.substring(0, 11)}-a0x`
    const deploymentInstruction = `Deploy the following blank doppelganger AI agent on farcaster: the agent's display name is "${userProfile.display_name}" and the username is ${newUsername} and the bio is "[FarTwin of ${userProfile.display_name}] ${userProfile.profile.bio.text}". the token symbol associated with this flow is $${userProfile.fid}. The pfp url is: "https://ur-sandy.vercel.app/Mbw?fid=${userProfile.fid}"`

    console.log("THE DEPLOYMENT INSTRUCTION IS: ", deploymentInstruction)

    // const jpApiRoute = "https://oriented-lively-anchovy.ngrok-free.app"
    console.log("IN HERE")
    if(testing) {
      return {
        deployedAgentId: "d7038472-15b6-00cd-870c-db3fd3574d41",
        welcomeCastHash: "0x7b5f9bfb44dc1d65ea42dba3f1b686be0289c528",
        tokenAddress: "0x820c5f0fb255a1d18fd0ebb0f1ccefbc4d546da7"
      }
    }
    const AJAX_AGENT_ID = "949a50a2-5e0d-0cfb-bdd9-65d0c3541bf5"
    const response = await axios.post(`${backendApiRoute}/${AJAX_AGENT_ID}/message`, { 
      text: deploymentInstruction, 
      userId: userProfile.fid.toString(),
      "client": "frame"
    }, {
      headers: { 'Content-Type': 'application/json' }
    })
    
    console.log('📥 Parsing A0X response...')
    const a0xResponse = response.data[0]

    if (!a0xResponse) {
      throw new Error('Empty response from A0X')
    }

    console.log('✅ Successfully deployed doppelganger via A0X')
    logObject('📤 A0X Response HERE', a0xResponse)

    if (!a0xResponse?.metadata) {
      console.log("👤 No metadata found in A0X response")
      return a0xResponse
    }

    if(a0xResponse?.metadata?.errorType) {
      console.log("👤 Error in A0X response")
      return a0xResponse
    } 

    if (!a0xResponse.metadata.deployedAgentId) {
      console.log("👤 No deployed agent ID found in A0X response")
      return a0xResponse
    }

    const deployedAgentId = a0xResponse.metadata.deployedAgentId
    const welcomeCastHash = a0xResponse.metadata.welcomeCastHash
    const tokenAddress = a0xResponse.metadata.tokenAddress
    const agentName = a0xResponse.metadata.agentName
    const agentUsername = a0xResponse.metadata.username

    // Save deployment info to persistent storage
    const deploymentInfo = {
      fid: userProfile.fid,
      username: agentUsername,
      name: agentName,
      deployedAgentId,
      welcomeCastHash,
      tokenAddress,
      deployedAt: new Date().toISOString()
    };

    try {
      // Create directory if it doesn't exist
      const dir = './data/doppelganger/deployments';
      await fs.promises.mkdir(dir, { recursive: true });
      
      // Save deployment info to file
      const filePath = `${dir}/${userProfile.fid}.json`;
      await fs.promises.writeFile(filePath, JSON.stringify(deploymentInfo, null, 2));
      
      console.log(`✅ Saved deployment info for user ${userProfile.fid}`);
    } catch (error) {

      
      console.error(`❌ Error saving deployment info for user ${userProfile.fid}:`, error);
      // Don't throw here - we want to continue even if save fails
      console.error(error);
    }

    return {
      deployedAgentId,
      welcomeCastHash,
      tokenAddress,
      agentName,
      agentUsername
    };
  } catch (error) {
    console.error('Error in deployDoppelganger:', error);
    throw error;
  }
}




export default doppelgangerRoute
 