import { Hono } from 'hono'
import { 
  ParseWebhookEvent,
  parseWebhookEvent, 
  verifyAppKeyWithNeynar,
  SendNotificationRequest,
  sendNotificationResponseSchema
} from '@farcaster/frame-node'
import * as fs from 'fs/promises'
import * as path from 'path'
import { randomUUID } from 'crypto'
import * as cron from 'node-cron'
import { readdir } from 'fs/promises'

// Initialize app and set up directories only once
const appreciationApp = new Hono()
const appreciationDir = path.join(process.cwd(), 'data', 'appreciation')

// Type definitions
interface NotificationDetails {
  url: string;
  token: string;
  enabled: boolean;
  lastUpdated: number;
}

interface NotificationStore {
  [key: string]: NotificationDetails;
}

type SendFrameNotificationResult =
  | { state: "error"; error: unknown }
  | { state: "no_token" }
  | { state: "rate_limit" }
  | { state: "success" };

// Helper functions
async function getUserNotificationDetails(fid: number): Promise<NotificationDetails | null> {
  try {
    const userDir = path.join(appreciationDir, fid.toString())
    const notificationFile = path.join(userDir, 'notifications.json')
    
    try {
      await fs.access(userDir)
      await fs.access(notificationFile)
    } catch {
      return null
    }

    const data = await fs.readFile(notificationFile, 'utf8')
    const notifications: NotificationStore = JSON.parse(data)
    return notifications[fid] || null
  } catch (err) {
    console.error(`Error getting notification details for FID ${fid}:`, err)
    return null
  }
}

async function sendFrameNotification({
  fid,
  title,
  body,
  notificationDetails
}: {
  fid: number;
  title: string;
  body: string;
  notificationDetails?: NotificationDetails;
}): Promise<SendFrameNotificationResult> {
  const details = notificationDetails || await getUserNotificationDetails(fid)
  if (!details) {
    return { state: "no_token" }
  }

  try {
    const response = await fetch(details.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        notificationId: randomUUID(),
        title,
        body,
        targetUrl: 'https://appreciation.lat',
        tokens: [details.token],
      } satisfies SendNotificationRequest),
    })

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

async function getAllUserNotifications(): Promise<Map<number, NotificationDetails>> {
  console.log('📝 Getting all user notifications...')
  const notifications = new Map<number, NotificationDetails>()
  try {
    const userDirs = await readdir(appreciationDir)
    console.log('📂 Found user directories:', userDirs)
    
    for (const fidDir of userDirs) {
      const fid = parseInt(fidDir)
      if (isNaN(fid)) {
        console.log('⚠️ Invalid FID directory:', fidDir)
        continue
      }
      
      console.log('👤 Processing FID:', fid)
      const details = await getUserNotificationDetails(fid)
      if (details?.enabled) {
        console.log('✅ Adding enabled notification for FID:', fid)
        notifications.set(fid, details)
      } else {
        console.log('❌ Skipping disabled notification for FID:', fid)
      }
    }
  } catch (err) {
    console.error('❌ Error reading user notifications:', err)
  }
  console.log('✨ Returning notifications map with size:', notifications.size)
  return notifications
}

// Set up cron job with rate limiting
let isJobRunning = false

async function sendDailyAppreciationReminders() {
  if (isJobRunning) {
    console.log('Previous job still running, skipping...')
    return
  }

  try {
    isJobRunning = true
    const users = await getAllUserNotifications()
    const today = new Date().toISOString().split('T')[0]
    
    // Keep track of failed notifications to retry
    const failedNotifications = new Map<number, NotificationDetails>()
    
    for (const [fid, details] of Array.from(users.entries())) {
      try {
        // Check if we already sent notification today
        const notificationLogPath = path.join(appreciationDir, fid.toString(), 'notification_log.json')
        let notificationLog = {}
        try {
          const existing = await fs.readFile(notificationLogPath, 'utf8')
          notificationLog = JSON.parse(existing)
        } catch (err) {
          // File doesn't exist yet, use empty object
        }

        if (notificationLog[today]) {
          console.log(`Already sent notification to FID ${fid} today, skipping`)
          continue
        }

        const result = await sendFrameNotification({
          fid,
          title: "Daily Appreciation Reminder",
          body: "Now is the time to tell us something that happened to you today.",
          notificationDetails: details
        })
        
        if (result.state === "success") {
          // Log successful notification
          notificationLog[today] = {
            timestamp: new Date().toISOString(),
            status: 'success'
          }
          await fs.writeFile(notificationLogPath, JSON.stringify(notificationLog, null, 2))
        } else if (result.state === "rate_limit") {
          console.log(`Rate limited for FID ${fid}, adding remaining users to retry queue`)
          // Add this and remaining users to failed notifications
          const remainingUsers = Array.from(users.entries())
            .slice(Array.from(users.entries()).findIndex(([id]) => id === fid))
          for (const [remainingFid, remainingDetails] of remainingUsers) {
            failedNotifications.set(remainingFid, remainingDetails)
          }
          break
        } else {
          // Log failed notification and add to retry queue
          notificationLog[today] = {
            timestamp: new Date().toISOString(),
            status: 'error',
            error: result.state === 'error' ? result.error : 'Unknown error'
          }
          await fs.writeFile(notificationLogPath, JSON.stringify(notificationLog, null, 2))
          failedNotifications.set(fid, details)
        }
      } catch (err) {
        console.error(`Failed to send reminder to FID ${fid}:`, err)
        // Log error and add to retry queue
        const notificationLogPath = path.join(appreciationDir, fid.toString(), 'notification_log.json')
        const errorLog = {
          [today]: {
            timestamp: new Date().toISOString(),
            status: 'error',
            error: err.message
          }
        }
        await fs.writeFile(notificationLogPath, JSON.stringify(errorLog, null, 2))
        failedNotifications.set(fid, details)
      }
      
      // Add delay between notifications
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    // Write failed notifications to backup file
    const backupDir = path.join(appreciationDir, 'backup')
    await fs.mkdir(backupDir, { recursive: true })
    const backupPath = path.join(backupDir, `failed_notifications_${today}.json`)
    await fs.writeFile(backupPath, JSON.stringify(Array.from(failedNotifications.entries()), null, 2))

    // Write daily summary log
    const summaryLogPath = path.join(backupDir, 'notification_summaries.json')
    let summaryLog = {}
    try {
      const existing = await fs.readFile(summaryLogPath, 'utf8')
      summaryLog = JSON.parse(existing)
    } catch (err) {
      // File doesn't exist yet, use empty object
    }
    
    summaryLog[today] = {
      timestamp: new Date().toISOString(),
      totalUsers: users.size,
      successfulNotifications: users.size - failedNotifications.size,
      failedNotifications: failedNotifications.size
    }
    await fs.writeFile(summaryLogPath, JSON.stringify(summaryLog, null, 2))

  } finally {
    isJobRunning = false
  }
}

// Retry failed notifications after 1 hour
async function retryFailedNotifications() {
  const today = new Date().toISOString().split('T')[0]
  const backupPath = path.join(appreciationDir, 'backup', `failed_notifications_${today}.json`)
  
  try {
    const failedNotificationsData = await fs.readFile(backupPath, 'utf8')
    const failedNotifications = new Map(JSON.parse(failedNotificationsData))
    
    if (failedNotifications.size > 0) {
      console.log(`Retrying ${failedNotifications.size} failed notifications...`)
      for (const [fid, details] of failedNotifications) {
        await sendDailyAppreciationReminders()
      }
    }
  } catch (err) {
    console.log('No failed notifications to retry')
  }
}

// sendDailyAppreciationReminders()

// Schedule cron jobs
cron.schedule('0 17 * * *', sendDailyAppreciationReminders)
cron.schedule('0 18 * * *', retryFailedNotifications) // Retry after 1 hour


appreciationApp.post('/frames-webhook', async (c) => {
  try {
    const requestJson = await c.req.json()

    const neynarEnabled = process.env.NEYNAR_API_KEY && process.env.NEYNAR_CLIENT_ID
    if (!neynarEnabled) {
      return c.json({
        success: true,
        message: 'Neynar is not enabled, skipping webhook processing'
      })
    }

    let data;
    try {
      data = await parseWebhookEvent(requestJson, verifyAppKeyWithNeynar)
    } catch (e) {
      const error = e as ParseWebhookEvent.ErrorType

      switch (error.name) {
        case 'VerifyJsonFarcasterSignature.InvalidDataError':
        case 'VerifyJsonFarcasterSignature.InvalidEventDataError':
          return c.json({ success: false, error: error.message }, 400)
        case 'VerifyJsonFarcasterSignature.InvalidAppKeyError':
          return c.json({ success: false, error: error.message }, 401)
        case 'VerifyJsonFarcasterSignature.VerifyAppKeyError':
          return c.json({ success: false, error: error.message }, 500)
      }
    }

    const fid = data.fid
    const event = data.event

    // Create user directory
    const userDir = path.join(appreciationDir, fid.toString())
    await fs.mkdir(userDir, { recursive: true })

    // Handle notifications
    const notificationFile = path.join(userDir, 'notifications.json')
    
    let notifications: NotificationStore = {}
    try {
      const existing = await fs.readFile(notificationFile, 'utf8')
      notifications = JSON.parse(existing)
    } catch (err) {
      // File doesn't exist yet, use empty object
    }

    let notificationDetails: NotificationDetails | null = null;
    
    switch(event.event) {
      case 'frame_added':
        if (event.notificationDetails) {
          notificationDetails = {
            url: event.notificationDetails.url,
            token: event.notificationDetails.token,
            enabled: true,
            lastUpdated: Date.now()
          }
          notifications[fid] = notificationDetails
          
          await fs.writeFile(notificationFile, JSON.stringify(notifications, null, 2))
          
          await sendFrameNotification({
            fid,
            title: "Welcome to Appreciation",
            body: "Thanks for adding the frame. You'll receive a daily reminder to appreciate something.",
            notificationDetails
          })
        }
        break

      case 'frame_removed':
        delete notifications[fid]
        break

      case 'notifications_enabled':
        notificationDetails = {
          url: event.notificationDetails.url,
          token: event.notificationDetails.token,
          enabled: true,
          lastUpdated: Date.now()
        }
        notifications[fid] = notificationDetails
        break

      case 'notifications_disabled':
        if (notifications[fid]) {
          notifications[fid].enabled = false
          notifications[fid].lastUpdated = Date.now()
        }
        break
    }

    await fs.writeFile(notificationFile, JSON.stringify(notifications, null, 2))

    return c.json({
      success: true,
      message: `Successfully processed ${event.event} event for FID ${fid}`
    })

  } catch (error) {
    console.error('Error processing webhook:', error)
    if (error instanceof Error) {
      return c.json({ success: false, error: error.message }, 500)
    }
    return c.json({ success: false, error: 'An unknown error occurred' }, 500)
  }
})

appreciationApp.get("/transform-gratitude-into-aiagent", async (c) => {
  return c.json({
    success: true,
    message: 'Hello, world!'
  })
})

appreciationApp.get("/notifications", async (c) => {
  console.log("🔔 Getting all user notifications...")
  const notifications = await getAllUserNotifications()

  // Filter only active notifications
  const activeNotifications = new Map(
    Array.from(notifications.entries()).filter(([_, settings]) => settings.enabled)
  )

  const activeFids = Array.from(activeNotifications.keys())

  try {
    const enrichedNotifications: Array<{
      fid: any;
      user: any;
    }> = []
    
    // Process FIDs in chunks of 100
    for (let i = 0; i < activeFids.length; i += 100) {
      const fidChunk = activeFids.slice(i, i + 100)
      const fidsParam = fidChunk.join(',')
      // Fetch user details from Neynar API for current chunk
      const response = await fetch(`https://api.neynar.com/v2/farcaster/user/bulk?fids=${fidsParam}`, {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'x-neynar-experimental': 'false',
          'x-api-key': process.env.NEYNAR_API_KEY || ''
        }
      })

      const userData = await response.json()
      // Add enriched data for this chunk
      userData?.users?.forEach((user: any) => {
        enrichedNotifications.push({
          fid: user.fid,
          user: user
        })
      })
    }
    return c.json({
      success: true,
      subscribers: enrichedNotifications
    })
  } catch (err) {
    console.error('Error fetching user data from Neynar:', err)
    return c.json({
      success: false,
      error: 'Failed to fetch user details',
      notifications: Array.from(activeNotifications.entries()).map(([fid, settings]) => ({
        fid,
        notificationSettings: settings
      }))
    })
  }
})


export default appreciationApp
