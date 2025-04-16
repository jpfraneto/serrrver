import { NeynarAPIClient } from "@neynar/nodejs-sdk";
import { CastConversationSortType } from "@neynar/nodejs-sdk/build/api/models/cast-conversation-sort-type";
import { CastParamType } from "@neynar/nodejs-sdk/build/api/models/cast-param-type";
import fs from 'fs';
import { AppIdentifiers, NotificationStore, SendFrameNotificationResult } from "../types";
import axios from "axios";
import { sendNotificationResponseSchema } from "@farcaster/frame-node";
import { randomUUID } from "crypto";
import path from "path";
import { SendNotificationRequest } from "@farcaster/frame-node";

// Initialize Neynar client
const neynarClient = new NeynarAPIClient({
  apiKey: process.env.NEYNAR_API_KEY!
});


/**
 * Fetch user profile from Farcaster
 * @param {number} fid - The Farcaster ID of the user
 * @returns {Promise<object>} - User profile data
 */
export async function fetchUserProfile(fid: number) {
  try {
    const response = await neynarClient.fetchBulkUsers({
      fids: [fid]
    });
    return response.users[0];
  } catch (error) {
    console.error("Error fetching user profile:", error);
    throw error;
  }
}

/**
 * Fetch user casts from Farcaster
 * @param {number} fid - The Farcaster ID of the user
 * @param {number} limit - Number of casts to fetch (default: 50)
 * @returns {Promise<Array>} - Array of user casts
 */
export async function fetchUserCasts(fid: number, limit: number = 150) {
  try {
    // First try to read from local data
    try {
      const localCasts = await readUserCasts(fid);
      if (localCasts) {
        console.log(`📖 Found existing casts for user ${fid}`);
        return localCasts;
      }
    } catch (error) {
      console.log(`No local casts found for user ${fid}`);
    }

    // If not found locally, fetch from API
    const response = await neynarClient.fetchCastsForUser({
      fid: Number(fid),
      limit,
      cursor: undefined // Optional cursor for pagination
    });

    // Save the fetched casts locally
    await saveUserCasts(fid, response.casts);

    return response.casts;
  } catch (error) {
    console.error("Error fetching user casts:", error);
    throw error;
  }
}

/** 
 * Save user casts to local file
 * @param {number} fid - The Farcaster ID of the user
 * @param {Array} casts - Array of user casts
 */
async function saveUserCasts(fid: number, casts: any[]) {
    const dir = './data/doppelganger/casts';
    await fs.promises.mkdir(dir, { recursive: true });
    const filePath = `${dir}/${fid}.json`;
    await fs.promises.writeFile(filePath, JSON.stringify(casts, null, 2));
}

/**
 * Read user casts from local file
 * @param {number} fid - The Farcaster ID of the user
 * @returns {Promise<Array>} - Array of user casts  
 */
async function readUserCasts(fid: number) {
    const filePath = `./data/doppelganger/casts/${fid}.json`;
    try {
        await fs.promises.access(filePath);
        const data = await fs.promises.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch {
        return null;
    }
}

/**
 * Fetch user interactions from Farcaster
 * @param {number} fid - The Farcaster ID of the user
 * @returns {Promise<object>} - User interaction data
 */
export async function fetchUserInteractions(fid: number) {
  try {
    console.log(`👤 Fetching interactions for user ${fid}...`);
 
    // Get user's reactions (likes)
    console.log(`❤️ Fetching user likes...`);
    const reactions = await neynarClient.fetchUserReactions({
      fid: Number(fid),
      type: "likes", 
      limit: 100
    });
    console.log(`✅ Found ${reactions.reactions.length} likes`);

    // Get user's recasts
    console.log(`🔄 Fetching user recasts...`);
    const recasts = await neynarClient.fetchUserReactions({
      fid: Number(fid),
      type: "recasts",
      limit: 100
    });
    console.log(`✅ Found ${recasts.reactions.length} recasts`);

    // Get user's follows
    console.log(`👥 Fetching user follows...`);
    const follows = await neynarClient.fetchUserFollowers({
      fid: Number(fid),
      limit: 100
    });
    console.log(`✅ Found ${follows.users.length} follows`);

    return {
      reactions: reactions.reactions,
      recasts: recasts.reactions, 
      follows: follows.users
    };
  } catch (error) {
    console.error("❌ Error fetching user interactions:", error);
    throw error;
  }
}

export async function extractCastContext(hash: string) {
  const cast = await neynarClient.lookupCastConversation({
    identifier: hash,
    type: "hash",
    replyDepth: 3,
    includeChronologicalParentCasts: true,
    limit: 50
  });
  return cast
}

export async function ankyReplyToCast(hash: string, newCastString: string) {
  const replyHash = await neynarClient.publishCast({
    text: newCastString,
    parent: hash,
    embeds: [{
      url: "https://fartwins.lat"
    }],
    signerUuid: process.env.ANKY_SIGNER_UUID!
  })
  console.log("Reply has213417132h:", replyHash)
  return replyHash
}

export async function sendFrameNotificationForApp(appIdentifier: AppIdentifiers, toFid: number, title: string, body: string): Promise<SendFrameNotificationResult> {
  try {
    const userDir = path.join(process.cwd(), 'data', appIdentifier, toFid.toString())
    const notificationFile = path.join(userDir, 'notifications.json')
    
    let notifications: NotificationStore = {}
    try {
      const existing = await fs.promises.readFile(notificationFile, 'utf8')
      notifications = JSON.parse(existing)
    } catch {
      return { state: "no_token" }
    }

    const details = notifications[toFid]
    if (!details?.enabled) {
      return { state: "no_token" }
    }

    const response = await fetch(details.url, {
      method: "POST", 
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        notificationId: randomUUID(),
        title,
        body,
        targetUrl: `https://${appIdentifier}.lat`,
        tokens: [details.token],
      } satisfies SendNotificationRequest),
    })
    console.log("the response for sending the notification:", response)

    const responseJson = await response.json()

    if (response.status === 200) {
      const responseBody = sendNotificationResponseSchema.safeParse(responseJson)
      if (responseBody.success === false) {
        return { state: "error", error: responseBody.error.errors }
      }

      if (responseBody.data.result.rateLimitedTokens.length) {
        return { state: "rate_limit" }
      }

      return { state: "success" }
    } else {
      return { state: "error", error: responseJson }
    }
  } catch (err) {
    return { state: "error", error: err }
  }
}


export function formatConversationForLLM(conversationData) {
    // Extract the original cast (root of the conversation)
    const rootCast = conversationData.conversation.cast;
    
    // Format the main post
    let formattedConversation = `# Conversation on Farcaster\n\n`;
    
    // Add root cast author info
    formattedConversation += `## Original Post by @${rootCast.author.username} (${formatDate(rootCast.timestamp)})\n`;
    
    // Add user bio for context if available
    if (rootCast.author.profile?.bio?.text) {
      formattedConversation += `User bio: "${rootCast.author.profile.bio.text}"\n`;
    }
    
    // Add the main message
    formattedConversation += `\n"${rootCast.text}"\n`;
    
    // Add embedded content if any
    if (rootCast.embeds && rootCast.embeds.length > 0) {
      rootCast.embeds.forEach(embed => {
        if (embed.metadata?.html?.ogTitle) {
          formattedConversation += `\nShared link: "${embed.metadata.html.ogTitle}"\n`;
          if (embed.metadata.html.ogDescription) {
            formattedConversation += `Description: "${embed.metadata.html.ogDescription}"\n`;
          }
        } else if (embed.url) {
          formattedConversation += `\nShared content: ${embed.url}\n`;
        }
      });
    }
    
    // Process replies (direct_replies contains first-level replies)
    if (rootCast.direct_replies && rootCast.direct_replies.length > 0) {
      formattedConversation += `\n## Replies:\n`;
      
      rootCast.direct_replies.forEach(reply => {
        formattedConversation += formatReply(reply, 1);
      });
    }
    
    return formattedConversation;
  }
  
  // Helper function to format a single reply
  function formatReply(reply, depth) {
    // Create indentation based on depth
    const indent = "  ".repeat(depth);
    
    // Format the reply
    let formattedReply = `${indent}- @${reply.author.username} (${formatDate(reply.timestamp)}): "${reply.text}"\n`;
    
    // Add embedded content if any
    if (reply.embeds && reply.embeds.length > 0) {
      reply.embeds.forEach(embed => {
        if (embed.metadata?.html?.ogTitle) {
          formattedReply += `${indent}  Shared link: "${embed.metadata.html.ogTitle}"\n`;
        } else if (embed.url) {
          formattedReply += `${indent}  Shared content: ${embed.url}\n`;
        }
      });
    }
    
    // Process nested replies recursively
    if (reply.direct_replies && reply.direct_replies.length > 0) {
      reply.direct_replies.forEach(nestedReply => {
        formattedReply += formatReply(nestedReply, depth + 1);
      });
    }
    
    return formattedReply;
  }
  
  // Helper function to format date
  function formatDate(timestamp) {
    return new Date(timestamp).toLocaleString();
  }
  
