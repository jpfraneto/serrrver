// crypto-game-data-collector.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const csv = require('csv-parser');

// Set up directories
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// File paths
const csvFilePath = path.join(__dirname, 'players.csv');
const outputFilePath = path.join(dataDir, 'day9-final.json');

// Constants
const NFT_CONTRACT_ADDRESS = '0x87239d9CF8A95adAea78c5b4678B6398d115F140';
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY || 'your-neynar-api-key'; // Get from environment variable
const UNICHAIN_API_KEY = 'ab99dea8-1433-4356-8bf1-cdc0d76c2451';
const BATCH_SIZE = 100; // Process in batches to avoid rate limits
const BATCH_DELAY = 1000; // Delay between batches in ms

// Helper function to delay execution
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to chunk array into batches
const chunkArray = (array, size) => {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
};

// Step 1: Read player data from CSV
async function getPlayersFromCSV() {
  console.log('📄 Reading player data from CSV file...');
  
  return new Promise((resolve, reject) => {
    const players = [];
    
    fs.createReadStream(csvFilePath)
      .pipe(csv())
      .on('data', (data) => {
        // Only include rows with an Id
        if (data.Id) {
          players.push({
            id: data.Id,
            csvData: data
          });
        }
      })
      .on('end', () => {
        console.log(`✅ Successfully read ${players.length} players from CSV`);
        resolve(players);
      })
      .on('error', (error) => {
        console.error('❌ Error reading CSV:', error);
        reject(error);
      });
  });
}

// Step 2: Get NFT metadata for each player
async function getNFTMetadata(tokenId) {
  try {
    const url = `https://cryptothegame.com/api/nft-metadata/s3/${tokenId}.json`;
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    console.error(`❌ Error fetching NFT metadata for token ${tokenId}:`, error.message);
    return null;
  }
}

// Step 3: Get NFT ownership information from Unichain
async function getNFTOwner(tokenId) {
  try {
    const url = `https://unichain.blockscout.com/api/v2/tokens/${NFT_CONTRACT_ADDRESS}/instances/${tokenId}?apikey=${UNICHAIN_API_KEY}`;
    const response = await axios.get(url);
    return response.data.owner?.hash || null;
  } catch (error) {
    console.error(`❌ Error fetching NFT owner for token ${tokenId}:`, error.message);
    return null;
  }
}

// Step 4: Get Farcaster user data for addresses in batches
async function getFarcasterUsers(addresses) {
  if (!addresses || addresses.length === 0) return {};
  
  console.log(`🔍 Looking up Farcaster users for ${addresses.length} addresses...`);
  
  // Create a mapping of address to user data
  const addressToUser = {};
  
  // Split addresses into batches (max 350 per request)
  const batches = chunkArray(addresses, 350);
  
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`⏳ Processing address batch ${i+1}/${batches.length} (${batch.length} addresses)...`);
    
    try {
      const addressesParam = batch.join('%2C');
      const url = `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${addressesParam}`;
      
      const response = await axios.get(url, {
        headers: {
          'accept': 'application/json',
          'x-api-key': NEYNAR_API_KEY
        }
      });
      
      // Process the response and map addresses to users
      if (response.data.users) {
        for (const user of response.data.users) {
          // Check all verified addresses for this user
          const userAddresses = [
            ...(user.verified_addresses?.eth_addresses || []),
            user.custody_address
          ].filter(Boolean).map(addr => addr.toLowerCase());
          
          // Map each address to this user
          for (const addr of userAddresses) {
            addressToUser[addr] = user;
          }
        }
      }
    } catch (error) {
      console.error('❌ Error fetching Farcaster users by addresses:', error.message);
    }
    
    // Add delay between batches to avoid rate limiting
    if (i < batches.length - 1) {
      await delay(BATCH_DELAY);
    }
  }
  
  return addressToUser;
}

// Step 5: Get recent casts for a user
async function getUserCasts(fid) {
  try {
    const url = `https://api.neynar.com/v2/farcaster/feed/user/casts?fid=${fid}&limit=50&include_replies=true`;
    
    const response = await axios.get(url, {
      headers: {
        'accept': 'application/json',
        'x-api-key': NEYNAR_API_KEY
      }
    });
    
    return response.data.casts || [];
  } catch (error) {
    console.error(`❌ Error fetching casts for FID ${fid}:`, error.message);
    return [];
  }
}

// Step 6: Generate summary with local LLM
async function generatePlayerSummary(player) {
  try {
    // Prepare data about the player for the prompt
    const tribeInfo = player.nftMetadata?.attributes?.find(attr => attr.trait_type === "Tribe")?.value || "Unknown";
    const statusInfo = player.nftMetadata?.attributes?.find(attr => attr.trait_type === "Status")?.value || "Unknown";
    const immunities = player.nftMetadata?.attributes?.find(attr => attr.trait_type === "Earned Immunities")?.value || 0;
    
    // Prepare casts content if available
    let castsContent = "";
    if (player.casts && player.casts.length > 0) {
      castsContent = player.casts.slice(0, 10).map(cast => cast.text).join("\n");
    }
    
    // Create conversation messages
    const conversation = [
      {
        role: "system",
        content: "You are a game analyst for Crypto: The Game, a blockchain-based social strategy game similar to Survivor."
      },
      {
        role: "user",
        content: `
Analyze this player in "Crypto: The Game" and create a one-paragraph summary:

Username: ${player.csvData.Username || 'Unknown'}
Tribe: ${tribeInfo}
Status: ${statusInfo}
Earned Immunities: ${immunities}
Twitter: ${player.csvData['Twitter link (auto)'] || 'None'}
Telegram: ${player.csvData['Telegram (edit here)'] || 'None'}
Notes: ${player.csvData['Notes (edit here)'] || 'None'}

Recent activity/posts:
${castsContent || "No recent posts found."}

Provide a strategic assessment based on this information. What's their gameplay style? Are they social, strategic, or under the radar? Assess their current position in one paragraph.`
      }
    ];
    
    // Call local LLM through our server
    const response = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama3.2',
        messages: conversation,
        stream: false
      })
    });
    
    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.message.content;
  } catch (error) {
    console.error('❌ Error generating player summary:', error.message);
    return "Unable to generate player summary at this time.";
  }
}

// Main function to orchestrate the data collection process
async function main() {
  console.log('🎮 Starting Crypto: The Game data collection process...');
  
  try {
    // Step 1: Get players from CSV
    const players = await getPlayersFromCSV();
    
    // Step 2: Enrich with NFT metadata and filter for active players
    console.log('🔄 Enriching player data with NFT metadata...');
    const enrichedPlayers = [];
    
    // Process in batches
    const playerBatches = chunkArray(players, BATCH_SIZE);
    
    for (let i = 0; i < playerBatches.length; i++) {
      const batch = playerBatches[i];
      console.log(`⚙️ Processing batch ${i+1}/${playerBatches.length} (${batch.length} players)...`);
      
      const batchPromises = batch.map(async (player) => {
        // Get NFT metadata
        const nftMetadata = await getNFTMetadata(player.id);
        if (!nftMetadata) return null;
        
        // Check if player is alive
        const status = nftMetadata.attributes?.find(attr => attr.trait_type === "Status")?.value;
        if (status !== "Alive") {
          console.log(`👻 Player #${player.id} is not alive (${status}). Skipping.`);
          return null;
        }
        
        // Get NFT owner
        const ownerAddress = await getNFTOwner(player.id);
        if (!ownerAddress) return null;
        
        return {
          ...player,
          nftMetadata,
          ownerAddress
        };
      });
      
      const batchResults = await Promise.all(batchPromises);
      const validPlayers = batchResults.filter(p => p !== null);
      enrichedPlayers.push(...validPlayers);
      
      console.log(`✅ Found ${validPlayers.length} active players in this batch`);
      
      // Add delay between batches
      if (i < playerBatches.length - 1) {
        await delay(BATCH_DELAY);
      }
    }
    
    console.log(`🧩 Found a total of ${enrichedPlayers.length} active players`);
    
    // Step 3: Get Farcaster user data for wallet addresses
    const addresses = enrichedPlayers
      .map(player => player.ownerAddress)
      .filter(Boolean)
      .map(addr => addr.toLowerCase());
    
    console.log(`🔎 Looking up Farcaster data for ${addresses.length} wallet addresses...`);
    const addressToFarcasterUser = await getFarcasterUsers(addresses);
    
    // Add Farcaster user data to players
    console.log('🔄 Adding Farcaster user data to player information...');
    for (const player of enrichedPlayers) {
      if (player.ownerAddress) {
        const address = player.ownerAddress.toLowerCase();
        player.farcasterUser = addressToFarcasterUser[address] || null;
      }
    }
    
    // Step 4: Get recent casts for each player with a Farcaster account
    console.log('💬 Fetching recent casts for players with Farcaster accounts...');
    
    const playersWithFarcaster = enrichedPlayers.filter(p => p.farcasterUser);
    console.log(`📊 Found ${playersWithFarcaster.length} players with Farcaster accounts`);
    
    const castsBatches = chunkArray(playersWithFarcaster, BATCH_SIZE);
    
    for (let i = 0; i < castsBatches.length; i++) {
      const batch = castsBatches[i];
      console.log(`🔄 Fetching casts for batch ${i+1}/${castsBatches.length}...`);
      
      const batchPromises = batch.map(async (player) => {
        if (player.farcasterUser?.fid) {
          console.log(`📝 Fetching casts for player #${player.id} (FID: ${player.farcasterUser.fid})...`);
          const casts = await getUserCasts(player.farcasterUser.fid);
          player.casts = casts;
        }
        return player;
      });
      
      await Promise.all(batchPromises);
      
      // Add delay between batches
      if (i < castsBatches.length - 1) {
        await delay(BATCH_DELAY);
      }
    }
    
    // Step 5: Generate player summaries
    console.log('📝 Generating player summaries...');
    
    const summaryBatches = chunkArray(enrichedPlayers, BATCH_SIZE);
    
    for (let i = 0; i < summaryBatches.length; i++) {
      const batch = summaryBatches[i];
      console.log(`🧠 Generating summaries for batch ${i+1}/${summaryBatches.length}...`);
      
      const batchPromises = batch.map(async (player) => {
        console.log(`🔍 Analyzing player #${player.id}...`);
        const summary = await generatePlayerSummary(player);
        player.summary = summary;
        return player;
      });
      
      await Promise.all(batchPromises);
      
      // Add delay between batches
      if (i < summaryBatches.length - 1) {
        await delay(BATCH_DELAY);
      }
    }
    
    // Step 6: Prepare final data structure
    console.log('📊 Preparing final data structure...');
    
    const finalData = enrichedPlayers.map(player => {
      // Extract relevant information from NFT metadata
      const tribe = player.nftMetadata?.attributes?.find(attr => attr.trait_type === "Tribe")?.value || "Unknown";
      const status = player.nftMetadata?.attributes?.find(attr => attr.trait_type === "Status")?.value || "Unknown";
      const earnedImmunities = player.nftMetadata?.attributes?.find(attr => attr.trait_type === "Earned Immunities")?.value || 0;
      const availableImmunities = player.nftMetadata?.attributes?.find(attr => attr.trait_type === "Available Immunities")?.value || 0;
      
      return {
        tokenId: player.id,
        username: player.csvData.Username,
        tribe,
        status,
        immunities: {
          earned: earnedImmunities,
          available: availableImmunities
        },
        ownerAddress: player.ownerAddress,
        twitter: player.csvData['Twitter link (auto)'] || null,
        telegram: player.csvData['Telegram (edit here)'] || null,
        notes: player.csvData['Notes (edit here)'] || null,
        farcaster: player.farcasterUser ? {
          fid: player.farcasterUser.fid,
          username: player.farcasterUser.username,
          displayName: player.farcasterUser.display_name,
          followerCount: player.farcasterUser.follower_count,
          followingCount: player.farcasterUser.following_count
        } : null,
        recentCasts: player.casts ? player.casts.slice(0, 10).map(cast => ({
          text: cast.text,
          timestamp: cast.timestamp
        })) : [],
        summary: player.summary
      };
    });
    
    // Step 7: Write data to file
    console.log('💾 Writing data to file...');
    fs.writeFileSync(outputFilePath, JSON.stringify(finalData, null, 2));
    
    console.log(`✅ Success! Data for ${finalData.length} players written to ${outputFilePath}`);
  } catch (error) {
    console.error('❌ Error in main process:', error);
  }
}

// Run the script
main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});