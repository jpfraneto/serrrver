export type AppIdentifiers = "appreciation" | "fartwins"

export interface NotificationDetails {
    url: string;
    token: string;
    enabled: boolean;
    lastUpdated: number;
  }
  
export interface NotificationStore {
[key: string]: NotificationDetails;
}

export type SendFrameNotificationResult =
| { state: "error"; error: unknown }
| { state: "no_token" }
| { state: "rate_limit" }
| { state: "success" };   