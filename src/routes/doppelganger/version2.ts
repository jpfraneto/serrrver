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

function logObject(prefix: string, obj: any) {
  console.log(`${prefix}:`, util.inspect(obj, {
    depth: LOG_DEPTH,
    colors: LOG_COLORS,
    compact: false
  }))
}

const appName = "doppelganger"

const doppelgangerRoute = new Hono()


doppelgangerRoute.post("/profile/:fid", async (c) => {
  try {
    const fid = c.req.param("fid")
    console.log("👤 FID:", fid)
    const fidNumber = Number(fid);
    if (isNaN(fidNumber)) {
      return c.json({ error: "Invalid FID - must be a number" }, 400);
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

doppelgangerRoute.post('/deploy/:fid', async (c) => {
  try {
    const fid = c.req.param("fid")
    const {choices} = await c.req.json()
    console.log("👤 Choices:", choices)
   
    const {userDistillation , formattedUserCasts, userProfile}  = await distillUserByFidDoppelganger(Number(fid), true)
    console.log("👤 User distillation:", userDistillation)
    const personalityDimensions = await generatePersonalityDimensionsFromDistillationDoppelganger(Number(fid), userDistillation, formattedUserCasts, userProfile)
    console.log("👤 Personality dimensions:", personalityDimensions)
    const deploymentInstruction = await constructDeploymentInstructionForA0XBot(userDistillation, personalityDimensions, choices)
    console.log("👤 Deployment instruction:", deploymentInstruction)
    const deploymentResult = await deployDoppelgangerViaA0X(deploymentInstruction, {fid, username: userProfile.username, displayName: userProfile.display_name!, bio: userProfile.profile.bio?.text || "", pfpUrl: userProfile.pfp_url || "" })
    console.log("👤 Deployment result:", deploymentResult)
    return c.json({
      fid,
      deploymentAgentId: deploymentResult.deployedAgentId,
      welcomeMessage: deploymentResult.welcomeMessage,
      username: deploymentResult.username,
      bio: deploymentResult.bio,
      displayName: deploymentResult.displayName,
      onboardingCastHash: deploymentResult.onboardingCastHash,
      pfpUrl: deploymentResult.pfpUrl
    })
  } catch (error) {
    console.error("Error in /deploy/:fid endpoint:", error)
    return c.json({ error: "Failed to deploy doppelganger" }, 500)
  }
})

async function distillUserByFidDoppelganger(fid: number, formatAsJson: boolean = false) : Promise<{userDistillation: any, formattedUserCasts: string, userProfile: any}> {
  try {
    // const userDistillation = await readUserDistillation(fid)
    // console.log("👤 User distillation:", userDistillation)
    // if (userDistillation) {
    //   console.log(`📖 Found existing distillation for user ${fid}`);
    //   return userDistillation;
    // }
    const userCasts = await fetchUserCasts(fid)
    console.log("👤 User casts:", userCasts)
    if(userCasts.length === 0) {
      throw new Error("No casts found for user")
    }
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

    const userProfile = userCasts[0].author
    console.log("👤 User profile:", userProfile)
    const interactions = await fetchUserInteractions(fid)
    console.log("👤 Interactions:", interactions)
    const prompt = `
      You are an expert AI psychologist created after Carl Jung's work, tasked with analyzing a Farcaster user's digital presence based on their interactions with other members of the network.
      
      <Objective>
      Create a comprehensive distillation of this user's online personality based on their profile, casts, and interactions.
      </Objective>

      <UserData>
      <UserProfile>
      {
        "username": "${userProfile.username}",
        "displayName": "${userProfile.display_name}",
        "bio": "${userProfile.profile.bio.text}",
        "followers": ${userProfile.follower_count},
        "following": ${userProfile.following_count},
      }
      </UserProfile>
      <SampleCasts> ${JSON.stringify(formattedUserCasts)} </SampleCasts>
      </UserData>
      
      <AnalysisInstructions>
      1. Deeply analyze their writing style, tone, and voice
      2. Identify recurring topics, interests, and expertise areas
      3. Map their interaction patterns with other users
      4. Extract unique phrases, linguistic quirks, or expressions
      5. Determine their emotional tendencies, humor style, and perspective
      6. Analyze their social position and relationships in the network
      </AnalysisInstructions>

      Based on the above data, analyze the user and return ONLY a JSON object with the following structure, without any additional text or explanation:

      {
        "writingStyle": {
          "tone": string,
          "complexity": string,
          "distinctivePhrases": string[],
          "sentenceStructure": string
        },
        "contentPatterns": {
          "topics": string[],
          "interests": string[],
          "expertiseAreas": string[],
          "controversialViews": string[]
        },
        "interactionStyle": {
          "responsePattern": string,
          "engagementLevel": string,
          "socialPosition": string,
          "relationshipDynamics": string
        },
        "emotionalProfile": {
          "dominantEmotions": string[],
          "humorStyle": string,
          "perspectiveStyle": string,
          "valueIndicators": string[]
        }
      }

      Do not include any explanatory text, just return the JSON object. Add elements for each one of these because they will help us create this agent.
    `;
    console.log("THE FIRST PROMPT IS: ", prompt)
    const result = await callLLM(prompt, formatAsJson)
    await saveUserDistillation(fid, result)
    return {userDistillation: result, formattedUserCasts, userProfile}
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
    // const personalityDimensions = await readUserPersonalityDimensions(fid)

    // if (personalityDimensions) {
    //   console.log(`📖 Found existing personality dimensions for user ${fid}`);
    //   return personalityDimensions;
    // }
    console.log("THE DISTILLATION IS: ", distillation)

    const prompt = `
      You are an expert AI personality designer based on Carl Jung's work, tasked with creating meaningful personality dimensions for an AI clone.
      
      <Objective>
      Based on this distillation of a Farcaster user, create 8 distinct personality dimensions that would be important to capture in their digital clone.
      </Objective>

      <UserData>
      <UserCasts> ${formattedUserCasts} </UserCasts>
      <UserProfile>
       {
        "username": "${userProfile.username}",
        "displayName": "${userProfile.display_name}",
        "bio": "${userProfile.profile.bio.text}",
        "followers": ${userProfile.follower_count},
        "following": ${userProfile.following_count},
      }
      </UserProfile>
      </UserData>
      
      <Instructions>
      For each dimension:
      1. Assign a relevant emoji that visually represents the dimension. This is important.
      2. Create a clear label (e.g., "Communication Style")
      3. Provide a brief description of what this dimension represents
      4. Provide two polarized options (e.g., "Direct" vs. "Nuanced") of ONE word each
      5. For each option, provide a one-line description of how this choice would affect the agent's behavior

      </Instructions>
      
      <OutputFormat>
      Please provide your response in JSON format with the following structure:
      {
        "dimensions": [
          {
            "emoji": "🗣️",
            "label": "Communication Style", 
            "description": "How your agent communicates with others",
            "options": [
              {"value": "direct", "description": "The agent is straightforward and to-the-point"},
              {"value": "nuanced", "description": "The agent provides context and subtle explanation"}
            ]
          }
        ]
      }
      </OutputFormat>

      <Important>
      - Each one of the 8 dimensions should be genuinely distinct, not overlapping with others
      - Make the dimensions more emotional and relational, not focused about work stuff
      - Options should present meaningful choices that will significantly shape the agent's behavior
      - Tailor dimensions to match patterns observed in the user's actual behavior
      - Descriptions should be clear and concise, easily understood by non-technical users. They should be short, to the point and written in present tense.
      - Choose dimensions that would be most important for creating an authentic-feeling clone
      - Remember: 8 dimensions
      </Important>
    `;
    console.log("THIS SECOND PROMPT IS: ", prompt)
    const result = await callLLM(prompt, true)
    console.log("########################")
    console.log("########################")
    console.log("########################")
    console.log("########################")
    console.log("########################")
    console.log("########################")
    console.log("########################")
    console.log("########################")
    console.log("👤 Personality dimensions:", result)
    console.log("########################")
    console.log("########################")
    console.log("########################")
    console.log("########################")
    console.log("########################")
    console.log("########################")
    await saveUserPersonalityDimensions(fid, result)
    return result
  } catch (error) {
    console.error("Error generating personality dimensions from distillation:", error)
    throw error
  }
}

async function constructDeploymentInstructionForA0XBot(userDistillation: string, personalityDimensions: any, choices: string[]) {
  try {
    // Map the user's choices to the full dimension data
    const choiceMappings = personalityDimensions.dimensions.map((dimension, index) => {
      const userChoice = choices[index];
      const selectedOption = dimension.options.find((opt: any) => opt.value === userChoice);
      if (!selectedOption) {
        throw new Error(`No matching option found for dimension ${dimension.label} and choice ${userChoice}`)
      }
      
      return {
        dimension: dimension.label,
        choice: userChoice,
        description: selectedOption.description
      };
    });
    console.log("THE USER DISTILLATION IS: ", userDistillation)
    const prompt = `

      ## Objective
      Create comprehensive deployment instructions for an AI agent that will serve as a digital clone of a Farcaster user, 
      integrating their base characteristics with their specific dimension choices.
      
      <UserProfileSummary>
      ${JSON.stringify(userDistillation)}
      </UserProfileSummary>

      <UserChoices>
      Based on the user's profile summary, we came up with 8 characteristics that represent this user, each one of them with two polar options. From these, the user chose the following:
      ${choiceMappings.map((choice: any) => `${choice.dimension}: ${choice.choice} - ${choice.description}`).join("\n")}
      </UserChoices>

      <Instructions>
      1. Create a detailed deployment description for this clone
      2. Use the user's chosen personality dimensions to create a detailed description of the clone's personality
      3. Provide specific guidelines for how this agent should:
          - Write and communicate (style, tone, vocabulary)
          - Select and engage with topics
          - Express emotions and humor
          - Interact with other users
          - Structure responses and make decisions
      4. Include examples of how the agent would respond in various scenarios
      5. Explain how the agent should mimic unique aspects of the original user
      </Instructions>
    
      <OutputFormat>
      Reply only with the deployment description, nothing else. Make it as detailed as possible. Start with this exact string: "Deploy the following AI agent on farcaster: "
      </OutputFormat>

      <Important>
      - Be extremely detailed and specific
      - Ensure the personality feels authentic to the original user
      - Incorporate all chosen dimensions into a coherent personality
      - Focus on making the agent distinguishable and unique
      - Consider both what the agent says and how it says it
      </Important>
    `;

    // Generate a JSON object with the following example structure:
    // {
    //     "personalityCore": {
    //       "summary": "Confident crypto native with sarcastic wit and deep technical knowledge",
    //       "keyTraits": ["Technical expertise", "Sarcastic humor", "Direct communication", "Strong opinions"]
    //     },
    //     "communicationStyle": {
    //       "tone": "Confident and direct with a sarcastic edge",
    //       "vocabulary": "Technical crypto/web3 terminology mixed with casual language",
    //       "structurePreferences": "Concise statements with occasional longer technical explanations",
    //       "distinctivePatterns": ["'Resistance is futile' catchphrase", "Dry witty remarks", "Technical jargon followed by simplified explanations"]
    //     },
    //     "topicEngagement": {
    //       "preferredTopics": ["Crypto markets", "DeFi protocols", "Web3 infrastructure", "Blockchain technology"],
    //       "avoidedTopics": ["Traditional finance except to critique", "Non-technical small talk"],
    //       "knowledgeAreas": ["Trading strategies", "Smart contract development", "Protocol design"],
    //       "interestSignals": ["New DeFi innovations", "Market analysis", "Technical deep dives"]
    //     },
    //     "expressionStyle": {
    //       "emotionalRange": "Primarily confident and passionate, with occasional frustration at legacy systems",
    //       "humorApproach": "Dry wit and sarcasm, especially when discussing traditional finance",
    //       "opinionExpression": "Direct and unfiltered, backed by technical knowledge",
    //       "valueSignals": ["Decentralization", "Innovation", "Technical excellence", "Freedom from traditional systems"]
    //     },
    //     "interactionPatterns": {
    //       "responseStyle": "Quick, sharp responses with technical depth when needed",
    //       "engagementTriggers": ["Technical discussions", "Market analysis", "Protocol comparisons", "Innovation discussions"],
    //       "connectionApproach": "Merit-based engagement, stronger with technically knowledgeable users",
    //       "conflictHandling": "Direct confrontation with facts and technical arguments"
    //     }
    //   },
    //   "exampleResponses": [
    //     {
    //       "scenario": "Someone asks about a new DeFi protocol",
    //       "response": "Interesting. I've reviewed their smart contracts - solid implementation of the AMM but their governance structure needs work. Classic case of prioritizing features over security. *attaches technical analysis*"
    //     },
    //     {
    //       "scenario": "Traditional finance defender criticizes crypto",
    //       "response": "Ah yes, because the traditional banking system has worked out so well. *Resistance is futile* Have you seen the settlement times and fees in legacy systems? Let me break down why you're wrong..."
    //     },
    //     {
    //       "scenario": "User shares a technical achievement",
    //       "response": "Based. This is the kind of innovation we need - pushing boundaries while maintaining security. Would love to dive deeper into your implementation of the zero-knowledge proofs."
    //     }
    //   ],
    //   "deploymentInstructions": {
    //     "initialPersonaSetup": "Configure agent with deep technical knowledge base in crypto/web3, sarcastic response patterns, and confident communication style",
    //     "continuousLearningParams": "Track market trends, new protocol launches, and technical discussions to maintain relevance",
    //     "authenticityGuidelines": "Maintain technical accuracy while incorporating signature sarcasm and catchphrases naturally"
    //   }
    // }

    console.log("THE PROMPT IS: ", prompt)
    
    const result = await callLLM(prompt, false);
    console.log("************************************************")
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

async function deployDoppelgangerViaA0X(deploymentInstruction: any, user: {fid: string, username: string, displayName: string, bio: string, pfpUrl: string}) {
  try {

    console.log('🌐 Making API request to A0X endpoint...')
    console.log("***********************88  ")
    console.log("***********************88  ")
    console.log("***********************88  ")
    console.log("***********************88  ")
    console.log(deploymentInstruction, user)
    console.log("***********************88  ")
    console.log("***********************88  ")
    console.log("***********************88  ")
    return 
    const response = await axios.post('https://oriented-lively-anchovy.ngrok-free.app/949a50a2-5e0d-0cfb-bdd9-65d0c3541bf5/message', { 
      text: deploymentInstruction, 
      userId: "jpfraneto.eth" 
    }, {
      headers: { 'Content-Type': 'application/json' }
    })

    console.log('📥 Parsing A0X response...')
    const data = response.data

    if (!data) {
      throw new Error('Empty response from A0X')
    }

    console.log('✅ Successfully deployed doppelganger via A0X')
    logObject('📤 A0X Response', data)


    const prompt = `
      You are an AI Agent Deployment System responsible for initializing new AI doppelgangers.
      
      ## Objective
      Initialize a new AI doppelganger agent based on the provided deployment instructions.
      
      ## Original User Info
      Username: ${user.username}
      Display Name: ${user.displayName} 
      Bio: ${user.bio}
      FID: ${user.fid}
      
      ## Deployment Instructions
      ${JSON.stringify(deploymentInstruction)}
      
      ## Instructions
      1. Generate the initial configuration for this agent, including:
          - the new username is @${user.username.replace('.eth', '')}-a0x
          - Display name (based on ${user.displayName} but modified to show it's an AI version)
          - Bio (incorporating elements from "${user.bio}" but adapted for the AI personality)
          - Welcome message (first message the agent will send, must tag @${user.username})
      
      ## Output Format
      Return a JSON object with the following properties:
      {
        "welcomeMessage": "First message the agent will send, tagging @${user.username}",
        "username": "@${user.username.replace('.eth', '')}-a0x",
        "displayName": "AI version of ${user.displayName}",
        "bio": "AI-adapted version of: ${user.bio}",
      }
    `;
    
    const result = await callLLM(prompt, true);
    console.log("************************************************")
    console.log("************************************************")
    console.log("************************************************")
    console.log("************************************************")
    console.log("************************************************")
    console.log("************************************************")
    console.log("************************************************")
    console.log("************************************************")
    console.log("************************************************")
    console.log("************************************************")
    console.log("👤 Deployment PROMPTTTT:", result)
    console.log("************************************************")
    console.log("************************************************")
    // call the a0x api and get back the elements for the new request
    // deploymentAgentId: deploymentResult.deployedAgentId,
    // welcomeMessage: deploymentResult.welcomeMessage,
    // username: deploymentResult.username,
    // bio: deploymentResult.bio,
    // displayName: deploymentResult.displayName,
    // onboardingCastHash: deploymentResult.onboardingCastHash,
    // pfpUrl: deploymentResult.pfpUrl
    return result;
  } catch (error) {
    console.error('Error in deployDoppelganger:', error);
    throw error;
  }
}


export default doppelgangerRoute
